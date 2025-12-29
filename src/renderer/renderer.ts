/**
 * Renderer Script - Custom Window Chrome
 * 
 * This script handles custom window controls for frameless windows.
 * Only loaded when using custom title bar (frame: false).
 */

// ═══════════════════════════════════════════════════════════════════
// TYPE DECLARATIONS
// ═══════════════════════════════════════════════════════════════════

// The messengerBridge API from preload script
interface MessengerBridge {
  sendUnreadCount: (count: number) => void;
  reportError: (message: string, context: string) => void;
  onFocusChange: (callback: (focused: boolean) => void) => () => void;
  readonly platform: 'win32' | 'darwin' | 'linux';
}

// Extended window interface (overrides Window.messengerBridge to allow undefined)
interface ExtendedWindow {
  messengerBridge?: MessengerBridge;
}

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Initialize window controls and platform-specific styling.
 */
function initializeRenderer(): void {
  const win = window as unknown as ExtendedWindow;
  
  // Check if we have the bridge API
  if (!win.messengerBridge) {
    console.error('[Renderer] messengerBridge not available');
    return;
  }

  const bridge = win.messengerBridge;

  // Add platform class for CSS styling
  document.body.classList.add(`platform-${bridge.platform}`);

  // Set up window control buttons
  setupWindowControls(bridge);

  // Set up focus handling
  setupFocusHandling(bridge);

  console.log(`[Renderer] Initialized for platform: ${bridge.platform}`);
}

/**
 * Set up window control button event listeners.
 */
function setupWindowControls(bridge: MessengerBridge): void {
  // Minimize button
  const btnMinimize = document.getElementById('btn-minimize');
  if (btnMinimize) {
    btnMinimize.addEventListener('click', () => {
      // Note: We'd need to add window control methods to the bridge
      console.log('[Renderer] Minimize clicked');
      // bridge.minimizeWindow?.();
    });
  }

  // Maximize button
  const btnMaximize = document.getElementById('btn-maximize');
  if (btnMaximize) {
    btnMaximize.addEventListener('click', () => {
      console.log('[Renderer] Maximize clicked');
      // bridge.maximizeWindow?.();
    });
  }

  // Close button
  const btnClose = document.getElementById('btn-close');
  if (btnClose) {
    btnClose.addEventListener('click', () => {
      console.log('[Renderer] Close clicked');
      // bridge.closeWindow?.();
    });
  }

  // On macOS, hide controls if using native traffic lights
  if (bridge.platform === 'darwin') {
    const controls = document.querySelector('.window-controls');
    if (controls) {
      (controls as HTMLElement).style.display = 'none';
    }
  }
}

/**
 * Set up window focus visual feedback.
 */
function setupFocusHandling(bridge: MessengerBridge): void {
  // Update titlebar appearance based on focus
  bridge.onFocusChange((focused: boolean) => {
    const titlebar = document.querySelector('.titlebar');
    if (titlebar) {
      if (focused) {
        titlebar.classList.remove('unfocused');
        (titlebar as HTMLElement).style.opacity = '1';
      } else {
        titlebar.classList.add('unfocused');
        (titlebar as HTMLElement).style.opacity = '0.7';
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeRenderer, { once: true });
} else {
  initializeRenderer();
}
