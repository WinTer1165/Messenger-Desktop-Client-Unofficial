/**
 * Preload Script - Security Bridge
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  IPC_MAIN_CHANNELS,
  MessengerBridgeAPI,
  UnreadCountPayload,
  ErrorReportPayload,
} from '../shared/types';

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

/** Last detected unread count (for deduplication) */
let lastUnreadCount = -1;

/** Focus change listeners */
const focusChangeListeners = new Set<(focused: boolean) => void>();

/** Observer cleanup functions */
const cleanupFunctions: Array<() => void> = [];

// ═══════════════════════════════════════════════════════════════════
// SAFE IPC WRAPPER
// ═══════════════════════════════════════════════════════════════════

/**
 * Safely send IPC message to main process.
 * Wraps in try-catch to prevent any errors from propagating.
 */
function safeSend(channel: string, ...args: unknown[]): void {
  try {
    ipcRenderer.send(channel, ...args);
  } catch (error) {
    // Cannot use reportError here (would cause infinite loop)
    console.error('[Preload] IPC send failed:', error);
  }
}

// ═══════════════════════════════════════════════════════════════════
// UNREAD COUNT DETECTION
// ═══════════════════════════════════════════════════════════════════

function parseUnreadFromTitle(title: string): number {
  // Match pattern like "(N)" at the start of title
  const match = title.match(/^\((\d+)\+?\)/);
  
  if (match && match[1]) {
    const count = parseInt(match[1], 10);
    // Sanity check
    if (Number.isInteger(count) && count >= 0 && count <= 9999) {
      return count;
    }
  }
  
  return 0;
}

/**
 * Handle title change - detect and report unread count.
 */
function handleTitleChange(): void {
  const title = document.title;
  const count = parseUnreadFromTitle(title);
  
  // Deduplicate - only send if count changed
  if (count !== lastUnreadCount) {
    lastUnreadCount = count;
    
    const payload: UnreadCountPayload = {
      count,
      timestamp: Date.now(),
      source: 'title',
    };
    
    safeSend(IPC_CHANNELS.UNREAD_COUNT_UPDATE, payload);
    console.log(`[Preload] Unread count: ${count} (from title: "${title}")`);
  }
}

/**
 * Set up title observation using MutationObserver.
 */
function setupTitleObserver(): void {
  // Find or wait for the title element
  const titleElement = document.querySelector('title');
  
  if (!titleElement) {
    // Title element might not exist yet, retry after DOM loaded
    console.log('[Preload] Title element not found, will retry');
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setupTitleObserver();
      }, { once: true });
    }
    return;
  }

  // Create MutationObserver
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' || mutation.type === 'characterData') {
        handleTitleChange();
        break;
      }
    }
  });

  // Observe title element
  observer.observe(titleElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  // Also observe for title element replacement
  const head = document.head || document.querySelector('head');
  if (head) {
    const headObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Check if title element was replaced
          const newTitle = document.querySelector('title');
          if (newTitle && newTitle !== titleElement) {
            console.log('[Preload] Title element replaced, re-observing');
            observer.disconnect();
            setupTitleObserver();
            return;
          }
        }
      }
    });

    headObserver.observe(head, {
      childList: true,
    });

    cleanupFunctions.push(() => headObserver.disconnect());
  }

  // Initial check
  handleTitleChange();

  // Store cleanup function
  cleanupFunctions.push(() => observer.disconnect());

  console.log('[Preload] Title observer set up');
}

/**
 * Alternative: DOM-based unread detection.
 * 
 * @deprecated Kept for reference - enable manually if title observation fails
 * @example
 */
export function setupDOMObserver(): void {
  // Wait for page to load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupDOMObserver();
    }, { once: true });
    return;
  }

  // Look for unread indicators
  // These selectors WILL break - they're based on current Messenger structure
  const selectors = [
    // Thread list unread badges
    '[data-testid="mwthreadlist-item-open"] [aria-label*="unread"]',
    // Notification badge on conversations
    '[role="navigation"] [aria-label*="message"]',
    // Generic unread indicator
    '.unread-count',
  ];

  const findUnreadElements = (): number => {
    let count = 0;
    
    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        count += elements.length;
      } catch {
        // Selector might be invalid, skip
      }
    }
    
    return count;
  };

  // Set up periodic check (less efficient but more robust)
  const intervalId = setInterval(() => {
    const count = findUnreadElements();
    
    if (count !== lastUnreadCount) {
      lastUnreadCount = count;
      
      const payload: UnreadCountPayload = {
        count,
        timestamp: Date.now(),
        source: 'dom',
      };
      
      safeSend(IPC_CHANNELS.UNREAD_COUNT_UPDATE, payload);
      console.log(`[Preload] Unread count (DOM): ${count}`);
    }
  }, 2000); // Check every 2 seconds

  cleanupFunctions.push(() => clearInterval(intervalId));

  console.log('[Preload] DOM observer set up (fragile fallback)');
}

// ═══════════════════════════════════════════════════════════════════
// FOCUS HANDLING
// ═══════════════════════════════════════════════════════════════════

/**
 * Set up focus change listener from main process.
 */
function setupFocusListener(): void {
  ipcRenderer.on(IPC_MAIN_CHANNELS.WINDOW_FOCUS_CHANGED, (_event, payload) => {
    if (payload && typeof payload.focused === 'boolean') {
      // Notify all registered listeners
      for (const listener of focusChangeListeners) {
        try {
          listener(payload.focused);
        } catch (error) {
          console.error('[Preload] Focus listener error:', error);
        }
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// CONTEXT BRIDGE API
// ═══════════════════════════════════════════════════════════════════
const messengerBridgeAPI: MessengerBridgeAPI = {
  /**
   * Send unread count to main process.
   * Fire-and-forget - no return value prevents timing attacks.
   */
  sendUnreadCount: (count: number): void => {
    // Validate input
    if (!Number.isInteger(count) || count < 0 || count > 9999) {
      console.warn('[Preload] Invalid count from web content:', count);
      return;
    }

    const payload: UnreadCountPayload = {
      count,
      timestamp: Date.now(),
      source: 'dom', // Web content calling this manually
    };

    safeSend(IPC_CHANNELS.UNREAD_COUNT_UPDATE, payload);
  },

  /**
   * Report error to main process for logging.
   * Fire-and-forget - no return value.
   */
  reportError: (message: string, context: ErrorReportPayload['context']): void => {
    // Validate and sanitize
    if (typeof message !== 'string' || message.length === 0) {
      return;
    }

    // Truncate long messages to prevent DoS
    const sanitizedMessage = message.slice(0, 1000);

    const validContexts: ErrorReportPayload['context'][] = [
      'dom-observer',
      'title-observer',
      'ipc',
      'unknown',
    ];

    const validContext = validContexts.includes(context) ? context : 'unknown';

    const payload: ErrorReportPayload = {
      message: sanitizedMessage,
      context: validContext,
      timestamp: Date.now(),
    };

    safeSend(IPC_CHANNELS.ERROR_REPORT, payload);
  },

  /**
   * Register callback for window focus changes.
   * Returns cleanup function to unregister.
   */
  onFocusChange: (callback: (focused: boolean) => void): (() => void) => {
    if (typeof callback !== 'function') {
      console.warn('[Preload] Invalid focus callback');
      return () => {};
    }

    focusChangeListeners.add(callback);

    // Return cleanup function
    return () => {
      focusChangeListeners.delete(callback);
    };
  },

  /**
   * Get current platform.
   * Read-only, sanitized to prevent fingerprinting.
   */
  get platform(): 'win32' | 'darwin' | 'linux' {
    const p = process.platform;
    if (p === 'win32' || p === 'darwin' || p === 'linux') {
      return p;
    }
    return 'linux'; // Default fallback
  },
};

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Initialize the preload script.
 */
function initialize(): void {
  console.log('[Preload] Initializing...');

  // Expose API to renderer
  try {
    contextBridge.exposeInMainWorld('messengerBridge', messengerBridgeAPI);
    console.log('[Preload] API exposed as window.messengerBridge');

    // Expose electron API for title bar controls
    contextBridge.exposeInMainWorld('electronAPI', {
      minimizeWindow: () => safeSend('window-minimize'),
      maximizeWindow: () => safeSend('window-maximize'),
      closeWindow: () => safeSend('window-close'),
      zoomIn: () => safeSend('zoom-in'),
      zoomOut: () => safeSend('zoom-out'),
      zoomReset: () => safeSend('zoom-reset'),
      onZoomLevelChange: (callback: (level: number) => void) => {
        ipcRenderer.on('zoom-level-changed', (_event, level: number) => {
          callback(level);
        });
      },
    });
    console.log('[Preload] electronAPI exposed for title bar');
  } catch (error) {
    console.error('[Preload] Failed to expose API:', error);
    return;
  }

  // Set up observers
  setupTitleObserver();
  setupFocusListener();

  // Signal ready to main process
  safeSend(IPC_CHANNELS.APP_READY);

  console.log('[Preload] Initialization complete');
}

/**
 * Clean up on unload.
 */
function cleanup(): void {
  console.log('[Preload] Cleaning up...');

  for (const cleanupFn of cleanupFunctions) {
    try {
      cleanupFn();
    } catch {
      // Ignore cleanup errors
    }
  }

  focusChangeListeners.clear();
  cleanupFunctions.length = 0;

  console.log('[Preload] Cleanup complete');
}

// ═══════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  initialize();
}

// Clean up on unload
window.addEventListener('unload', cleanup, { once: true });

// ═══════════════════════════════════════════════════════════════════
// TYPE DECLARATIONS
// ═══════════════════════════════════════════════════════════════════

// Declare the API on the global Window interface
declare global {
  interface Window {
    messengerBridge: MessengerBridgeAPI;
  }
}
