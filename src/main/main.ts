/**
 * Main Process Entry Point
 * 
 * This is the entry point for the Electron main process.
 * It orchestrates:
 * - Application lifecycle (ready, quit, activate)
 * - BrowserWindow creation with secure defaults
 * - WebContentsView attachment for messenger.com
 * - Session/partition management for persistent login
 * - Integration with tray, IPC handlers, and window state
 * 
 * ═══════════════════════════════════════════════════════════════════
 * SECURITY ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════
 * 
 * Trust Levels:
 * 
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ MAIN PROCESS (this file) - FULLY TRUSTED                    │
 *   │ - Has full Node.js access                                   │
 *   │ - Manages native OS integrations                            │
 *   │ - Handles all IPC from preload                              │
 *   └─────────────────────────────────────────────────────────────┘
 *                              │
 *                        [IPC Channel]
 *                              │
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ PRELOAD SCRIPT - BRIDGE (LIMITED TRUST)                     │
 *   │ - Has contextBridge API only                                │
 *   │ - Can observe DOM in BrowserView                            │
 *   │ - Can send IPC to main (one-way, validated)                 │
 *   │ - NO Node.js, NO Electron internals                         │
 *   └─────────────────────────────────────────────────────────────┘
 *                              │
 *                       [contextBridge]
 *                              │
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ BROWSERVIEW (messenger.com) - UNTRUSTED                     │
 *   │ - Third-party web content                                   │
 *   │ - Fully sandboxed                                           │
 *   │ - Can only use minimal exposed API                          │
 *   │ - NO Node.js, NO Electron, NO IPC                           │
 *   └─────────────────────────────────────────────────────────────┘
 * 
 * ═══════════════════════════════════════════════════════════════════
 */

import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  shell,
  WebContents,
  dialog,
  nativeTheme,
  Menu,
  MenuItemConstructorOptions,
  clipboard,
  desktopCapturer,
} from 'electron';
import * as path from 'path';
import {
  MESSENGER_URL,
  SESSION_PARTITION,
  ThemeSetting,
} from '../shared/types';
import * as settings from './settings';
import { initializeAutoUpdater } from './updater';
import {
  getWindowState,
  attachWindowStateListeners,
  restoreWindowState,
} from './window-manager';
import { initializeTray, destroyTray } from './tray';
import {
  registerIpcHandlers,
  unregisterIpcHandlers,
  notifyFocusChange,
  setZoomFunctions,
  setThemeChangeCallback,
  setGoToHomeCallback,
  getMinimizeToTray,
} from './ipc-handlers';
import { createApplicationMenu, setMessengerView, zoomIn, zoomOut, zoomReset } from './menu';

// ═══════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════

let mainWindow: BrowserWindow | null = null;
let messengerView: WebContentsView | null = null;

/**
 * Resolve a theme setting to a concrete theme.
 * 'auto' follows the OS light/dark preference.
 */
function resolveTheme(setting: ThemeSetting): string {
  if (setting === 'auto') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }
  return setting;
}

// Concrete theme currently in effect (never 'auto').
// Resolved from the saved setting during initializeApp().
let currentTheme: string = 'dark';

// ═══════════════════════════════════════════════════════════════════
// PATH RESOLUTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the path to the preload script.
 * Handles both development and production paths.
 */
function getPreloadPath(): string {
  if (app.isPackaged) {
    // In production, preload is in resources
    return path.join(process.resourcesPath, 'preload', 'preload.js');
  }
  // In development, preload is in dist
  return path.join(__dirname, '..', 'preload', 'preload.js');
}

/**
 * Get the path to the title bar preload script.
 */
function getTitleBarPreloadPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'preload', 'titlebar-preload.js');
  }
  return path.join(__dirname, '..', 'preload', 'titlebar-preload.js');
}

// ═══════════════════════════════════════════════════════════════════
// SESSION CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Configure the session for messenger.com.
 * 
 * Uses a persistent partition to:
 * - Preserve login state across app restarts
 * - Isolate messenger.com cookies from other content
 * - Enable session-specific security policies
 */
function configureSession(): Electron.Session {
  const messengerSession = session.fromPartition(SESSION_PARTITION, {
    cache: true,
  });

  // Present a plain Chrome user agent: take the real one (so the Chrome
  // version never goes stale) and strip the Electron/app tokens that
  // trigger Facebook's "unsupported browser" detection.
  const realUserAgent = messengerSession
    .getUserAgent()
    .replace(/\sElectron\/[\d.]+/i, '')
    .replace(new RegExp(`\\s${app.getName()}/[\\d.]+`, 'i'), '');
  messengerSession.setUserAgent(realUserAgent);

  // Configure permissions
  messengerSession.setPermissionRequestHandler(
    (
      _webContents: WebContents,
      permission: string,
      callback: (granted: boolean) => void,
      details
    ) => {
      // Log permission requests for debugging
      console.log(`[Session] Permission request: ${permission}`, details.requestingUrl);

      // Do Not Disturb blocks notifications
      if (permission === 'notifications' && settings.getDoNotDisturb()) {
        callback(false);
        return;
      }

      // Whitelist permissions that Messenger needs
      const allowedPermissions = [
        'notifications',      // Desktop notifications
        'media',              // Camera/microphone for calls
        'mediaKeySystem',     // DRM for some media
        'clipboard-read',     // Copy/paste
        'clipboard-sanitized-write',
        'fullscreen',         // Fullscreen mode for calls
        'display-capture',    // Screen sharing
      ];

      if (allowedPermissions.includes(permission)) {
        callback(true);
      } else {
        console.warn(`[Session] Denied permission: ${permission}`);
        callback(false);
      }
    }
  );

  // Permission checks happen every time the page creates a Notification,
  // so this is what makes the Do Not Disturb toggle take effect instantly.
  messengerSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'notifications' && settings.getDoNotDisturb()) {
      return false;
    }
    return true;
  });

  // Block unwanted content (ads, tracking)
  messengerSession.webRequest.onBeforeRequest(
    { urls: ['*://*/*'] },
    (details, callback) => {
      const url = details.url;

      // Block known tracking/ad domains (extend as needed)
      const blockedPatterns = [
        /\.doubleclick\.net/,
        /\.googlesyndication\.com/,
        /facebook\.com\/tr\//,  // Facebook pixel
        /\.fbsbx\.com/,         // Some FB tracking
      ];

      for (const pattern of blockedPatterns) {
        if (pattern.test(url)) {
          console.log(`[Session] Blocked: ${url}`);
          callback({ cancel: true });
          return;
        }
      }

      callback({ cancel: false });
    }
  );

  // NOTE: We intentionally do NOT strip the Content-Security-Policy from
  // messenger.com responses. insertCSS/executeJavaScript from the main
  // process bypass page CSP, so removing it would only weaken the page's
  // own XSS protection with no benefit to us.

  // Handle screen sharing requests
  messengerSession.setDisplayMediaRequestHandler((_request, callback) => {
    console.log('[Session] Screen sharing request received');
    handleDisplayMediaRequest(callback);
  });

  console.log('[Session] Configured with partition:', SESSION_PARTITION);
  return messengerSession;
}

// ═══════════════════════════════════════════════════════════════════
// SCREEN SHARE PICKER
// ═══════════════════════════════════════════════════════════════════

/**
 * List available screens/windows and let the user pick one via a
 * native dialog. Returns null when there is nothing to share or the
 * user cancels.
 */
async function pickScreenShareSource(
  parent?: BrowserWindow
): Promise<Electron.DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
  console.log(`[ScreenShare] Found ${sources.length} screen/window sources`);

  if (sources.length === 0) {
    return null;
  }

  // Screens first, then windows
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  const windows = sources.filter((s) => s.id.startsWith('window:'));
  const ordered = [...screens, ...windows];

  const messageBoxOptions: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Share Your Screen',
    message: 'Choose what to share:',
    buttons: [
      ...screens.map((s) => `🖥️ ${s.name}`),
      ...windows.map((s) => `🪟 ${s.name}`),
      'Cancel',
    ],
    defaultId: 0,
    cancelId: ordered.length,
  };

  const result = parent
    ? await dialog.showMessageBox(parent, messageBoxOptions)
    : await dialog.showMessageBox(messageBoxOptions);

  if (result.response >= ordered.length) {
    return null; // Cancelled
  }
  return ordered[result.response];
}

/**
 * Shared handler for setDisplayMediaRequestHandler (used by both the
 * messenger session and call child windows). The Electron handler
 * expects a synchronous function, so the async picker is wrapped.
 */
function handleDisplayMediaRequest(
  callback: (streams: Electron.Streams) => void,
  parent?: BrowserWindow
): void {
  void pickScreenShareSource(parent)
    .then((source) => {
      if (source) {
        console.log(`[ScreenShare] User selected: ${source.name} (ID: ${source.id})`);
        callback({ video: source });
      } else {
        callback({});
      }
    })
    .catch((error: unknown) => {
      console.error('[ScreenShare] Failed to get desktop sources:', error);
      callback({});
    });
}

// ═══════════════════════════════════════════════════════════════════
// CSS INJECTION
// ═══════════════════════════════════════════════════════════════════

/**
 * Custom CSS to inject into messenger.com.
 * 
 * FRAGILITY WARNING:
 * These selectors are based on Messenger's current DOM structure.
 * They WILL break when Messenger updates their UI.
 * 
 * Mitigation strategy:
 * - Use general selectors where possible
 * - Use attribute selectors over class names
 * - Keep CSS minimal and focused
 * - Log errors and fail gracefully
 * 
 * What this CSS does:
 * - Removes some padding to maximize content area
 * - Adjusts for our custom window chrome (if using frameless)
 * - Hides promotional banners
 */
const CUSTOM_CSS = `
/* Custom styles for Messenger Desktop Wrapper - Minimal changes only */

/* Hide "Get the Messenger app" banners */
[role="banner"] a[href*="messenger.com/desktop"],
[role="banner"] [data-testid*="download"] {
  display: none !important;
}

/* Hide promotional elements */
[data-testid="MWJewelThreadListContainer"] > div:first-child > div[role="banner"] {
  display: none !important;
}
`;

/**
 * Generate theme-specific CSS for messenger content.
 * MINIMAL - Only for call windows, does not modify main Messenger UI
 */
function getThemeCSS(theme: string): string {
  // Return empty CSS - keep original Messenger UI unchanged
  return `
/* Theme: ${theme} - No modifications to preserve original Messenger UI */
`;
}

/**
 * Inject custom CSS into the messenger view.
 */
async function injectCustomCSS(view: WebContentsView, theme: string = 'dark'): Promise<void> {
  try {
    await view.webContents.insertCSS(CUSTOM_CSS);
    await view.webContents.insertCSS(getThemeCSS(theme));
    console.log('[CSS] Custom styles injected with theme:', theme);
  } catch (error) {
    console.error('[CSS] Failed to inject styles:', error);
  }
}

/**
 * Inject JavaScript to auto-scroll to latest messages.
 */
async function injectAutoScrollJS(view: WebContentsView): Promise<void> {
  try {
    const autoScrollScript = `
      (function() {
        console.log('[AutoScroll] Initializing auto-scroll script...');

        let scrollContainer = null;
        let observer = null;
        let lastScrollTime = Date.now();
        const SCROLL_DEBOUNCE = 100; // ms

        // Function to find the message container
        function findMessageContainer() {
          // Try multiple selectors that Messenger might use
          const selectors = [
            'div[role="main"] div[data-scope="messages_table"]',
            'div[role="main"] > div > div > div',
            'div[data-pagelet="MWJewelThreadListContainer"] ~ div',
            'div[class*="message"] div[class*="scroll"]',
            'div[aria-label*="Messages"]',
          ];

          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              // Check if element is scrollable
              if (el.scrollHeight > el.clientHeight) {
                console.log('[AutoScroll] Found scrollable container:', selector);
                return el;
              }
            }
          }

          // Fallback: find any scrollable div in main
          const mainElement = document.querySelector('div[role="main"]');
          if (mainElement) {
            const allDivs = mainElement.querySelectorAll('div');
            for (const div of allDivs) {
              if (div.scrollHeight > div.clientHeight && div.scrollHeight > 500) {
                console.log('[AutoScroll] Found fallback scrollable container');
                return div;
              }
            }
          }

          return null;
        }

        // How close to the bottom (px) the user must be for auto-scroll
        // to kick in. If they scrolled up to read history, leave them alone.
        const NEAR_BOTTOM_THRESHOLD = 150;

        function isNearBottom(el) {
          return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
        }

        // Function to scroll to bottom.
        // Unless force=true, only scrolls when the user is already near
        // the bottom, so reading old messages is never interrupted.
        function scrollToBottom(smooth = true, force = false) {
          if (!scrollContainer) {
            scrollContainer = findMessageContainer();
          }

          if (scrollContainer) {
            if (!force && !isNearBottom(scrollContainer)) {
              return; // User is reading history - don't yank them down
            }

            const now = Date.now();
            if (now - lastScrollTime < SCROLL_DEBOUNCE) {
              return; // Debounce
            }
            lastScrollTime = now;

            scrollContainer.scrollTo({
              top: scrollContainer.scrollHeight,
              behavior: smooth ? 'smooth' : 'auto'
            });
            console.log('[AutoScroll] Scrolled to bottom');
          }
        }

        // Watch for new messages
        function setupObserver() {
          // Disconnect old observer if exists
          if (observer) {
            observer.disconnect();
          }

          const mainElement = document.querySelector('div[role="main"]');
          if (!mainElement) {
            console.log('[AutoScroll] Main element not found, retrying...');
            setTimeout(setupObserver, 1000);
            return;
          }

          observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              // Check if nodes were added (new messages)
              if (mutation.addedNodes.length > 0) {
                scrollToBottom(true);
                break;
              }
            }
          });

          observer.observe(mainElement, {
            childList: true,
            subtree: true
          });

          console.log('[AutoScroll] MutationObserver set up');

          // Initial scroll (forced - on load we always want the latest)
          setTimeout(() => scrollToBottom(false, true), 500);
        }

        // Start observing
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', setupObserver);
        } else {
          setupObserver();
        }

        // Also scroll on page visibility change (when user comes back to app)
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) {
            setTimeout(() => scrollToBottom(true), 300);
          }
        });

        console.log('[AutoScroll] Auto-scroll script initialized');
      })();
    `;

    await view.webContents.executeJavaScript(autoScrollScript);
    console.log('[AutoScroll] JavaScript injected');
  } catch (error) {
    console.error('[AutoScroll] Failed to inject JavaScript:', error);
  }
}

/**
 * Inject a wrapper around window.Notification so that clicking a
 * desktop notification brings the app window to the front (Messenger's
 * own click handling still runs - we only add focus behavior).
 *
 * Runs in the page's main world, where the contextBridge API
 * (window.messengerBridge) is available.
 */
async function injectNotificationClickHandler(view: WebContentsView): Promise<void> {
  const script = `
    (function() {
      if (window.__mdwNotificationPatched) return;
      window.__mdwNotificationPatched = true;

      const NativeNotification = window.Notification;
      if (!NativeNotification) return;

      function PatchedNotification(title, options) {
        const notification = new NativeNotification(title, options);
        notification.addEventListener('click', function() {
          try {
            if (window.messengerBridge && window.messengerBridge.focusWindow) {
              window.messengerBridge.focusWindow();
            }
          } catch (e) { /* ignore */ }
        });
        return notification;
      }

      PatchedNotification.requestPermission =
        NativeNotification.requestPermission.bind(NativeNotification);
      Object.defineProperty(PatchedNotification, 'permission', {
        get: function() { return NativeNotification.permission; },
      });
      PatchedNotification.prototype = NativeNotification.prototype;

      window.Notification = PatchedNotification;
      console.log('[NotificationPatch] Click-to-focus enabled');
    })();
  `;

  try {
    await view.webContents.executeJavaScript(script);
  } catch (error) {
    console.error('[NotificationPatch] Failed to inject:', error);
  }
}

/**
 * Attach a native right-click context menu to the messenger view.
 * Provides spellcheck suggestions, clipboard actions, and link/image
 * helpers that the frameless window otherwise lacks.
 */
function setupContextMenu(view: WebContentsView): void {
  view.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];

    // Spellcheck suggestions for the misspelled word under the cursor
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        template.push({
          label: suggestion,
          click: () => view.webContents.replaceMisspelling(suggestion),
        });
      }
      template.push({
        label: 'Add to Dictionary',
        click: () =>
          view.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      template.push({ type: 'separator' });
    }

    // Link helpers
    if (params.linkURL) {
      template.push({
        label: 'Copy Link Address',
        click: () => clipboard.writeText(params.linkURL),
      });
      template.push({ type: 'separator' });
    }

    // Image helpers
    if (params.mediaType === 'image' && params.srcURL) {
      template.push({
        label: 'Copy Image',
        click: () => view.webContents.copyImageAt(params.x, params.y),
      });
      template.push({ type: 'separator' });
    }

    // Clipboard actions based on what's actually possible here
    if (params.isEditable && params.editFlags.canCut) {
      template.push({ label: 'Cut', click: () => view.webContents.cut() });
    }
    if (params.editFlags.canCopy && params.selectionText.trim().length > 0) {
      template.push({ label: 'Copy', click: () => view.webContents.copy() });
    }
    if (params.isEditable && params.editFlags.canPaste) {
      template.push({ label: 'Paste', click: () => view.webContents.paste() });
    }
    if (params.isEditable && params.editFlags.canSelectAll) {
      template.push({ label: 'Select All', click: () => view.webContents.selectAll() });
    }

    // Drop a trailing separator so the menu doesn't end with one
    while (template.length > 0 && template[template.length - 1].type === 'separator') {
      template.pop();
    }

    // Only show the menu when we have something useful to offer
    if (template.length > 0 && mainWindow) {
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    }
  });
}

/**
 * Handle theme change from titlebar.
 * Accepts a theme setting (possibly 'auto'), persists it, and applies
 * the resolved concrete theme.
 */
function handleThemeChange(theme: string): void {
  settings.setTheme(theme as ThemeSetting);
  currentTheme = resolveTheme(theme as ThemeSetting);
  console.log(`[Theme] Setting: ${theme}, resolved: ${currentTheme}`);

  // Re-inject CSS into messenger view
  if (messengerView && !messengerView.webContents.isDestroyed()) {
    messengerView.webContents.insertCSS(getThemeCSS(currentTheme)).catch((error: unknown) => {
      console.error('[Theme] Failed to inject theme CSS:', error);
    });
  }
}

/**
 * Handle go to home request - navigate to messenger.com
 */
function handleGoToHome(): void {
  console.log('[Navigation] Navigating to Messenger home');

  if (messengerView && !messengerView.webContents.isDestroyed()) {
    messengerView.webContents.loadURL(MESSENGER_URL).catch((error: unknown) => {
      console.error('[Navigation] Failed to navigate to home:', error);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// MESSENGER VIEW MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * React to navigations in the messenger view: detect a completed
 * Facebook login (redirect to Messenger) and record when the user has
 * reached messenger.com.
 */
async function handleMessengerNavigation(view: WebContentsView, url: string): Promise<void> {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;
  const hasLoggedIn = settings.getHasLoggedIn();

  // If user hasn't logged in yet and they're on Facebook
  if (!hasLoggedIn && hostname.includes('facebook.com')) {
    // Check if they've successfully logged in by looking for session cookies
    const cookies = await view.webContents.session.cookies.get({ domain: '.facebook.com' });
    const hasFacebookSession = cookies.some(cookie =>
      cookie.name === 'c_user' || cookie.name === 'xs'
    );

    // Also check if they're on the homepage (not login page, not 2FA checkpoint)
    const isOnHomepage = url === 'https://www.facebook.com/' ||
                        url === 'https://www.facebook.com' ||
                        url.startsWith('https://www.facebook.com/?');

    if (hasFacebookSession && isOnHomepage) {
      console.log('[Login] Facebook login confirmed with valid session, redirecting to Messenger in 3 seconds...');
      // Give user a moment to see they're logged in, then redirect
      setTimeout(() => {
        if (!view.webContents.isDestroyed()) {
          view.webContents.loadURL(MESSENGER_URL).catch((error: unknown) => {
            console.error('[Login] Failed to navigate to Messenger:', error);
          });
        }
      }, 3000);
    }
  }

  // Check if user navigated to messenger.com successfully
  // This indicates they completed the login flow
  if (hostname.includes('messenger.com')) {
    if (!hasLoggedIn) {
      console.log('[Login] User has reached Messenger, marking login as complete');
      settings.setHasLoggedIn(true);
    }
  }
}

/**
 * Create and configure the WebContentsView for messenger.com.
 *
 * WHY WEBCONTENTSVIEW INSTEAD OF WEBVIEW TAG:
 * - WebContentsView is out-of-process (more secure)
 * - webview tag is deprecated and has known security issues
 * - WebContentsView is the successor to the deprecated BrowserView
 * - Easier to manage bounds and layering
 */
function createMessengerView(parentSession: Electron.Session): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      // ═══════════════════════════════════════════════════════════
      // SECURITY CRITICAL SETTINGS - DO NOT MODIFY
      // ═══════════════════════════════════════════════════════════
      
      // Enforce separate JavaScript contexts
      // Prevents messenger.com from accessing preload APIs directly
      contextIsolation: true,
      
      // Enable Chromium sandbox for OS-level process isolation
      // Limits damage if renderer is compromised
      sandbox: true,
      
      // Disable Node.js integration in renderer
      // messenger.com must not have access to Node APIs
      nodeIntegration: false,
      
      // Preload script - our ONLY bridge to the renderer
      preload: getPreloadPath(),
      
      // Use our configured session with persistent login
      session: parentSession,
      
      // Disable WebSQL (deprecated, security risk)
      webSecurity: true,
      
      // Disable file:// access from web content
      allowRunningInsecureContent: false,
      
      // Disable experimental features
      experimentalFeatures: false,
      
      // Enable spellcheck for better UX
      spellcheck: true,
      
      // Disable remote module (deprecated in Electron 14+, but explicit)
      // Note: This option is removed in Electron 38+, kept for documentation
      
      // Disable plugins
      plugins: false,
      
      // Disable webview tag (we use WebContentsView)
      webviewTag: false,
    },
  });

  // Navigation security - only allow messenger.com and related domains
  view.webContents.on('will-navigate', (event, url) => {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;

    // Allow messenger.com, facebook.com and their subdomains (for calls, media, etc.)
    const allowedPatterns = [
      /^(www\.)?messenger\.com$/,
      /^(www\.)?facebook\.com$/,
      /^.*\.messenger\.com$/,
      /^.*\.facebook\.com$/,
      /^.*\.fbcdn\.net$/,  // Facebook CDN for media
      /^.*\.fbsbx\.com$/,  // Facebook sandbox
    ];

    const isAllowed = allowedPatterns.some(pattern => pattern.test(hostname));

    if (!isAllowed) {
      console.log(`[Navigation] Blocked: ${url}`);
      event.preventDefault();
      // Open external URLs in default browser
      void shell.openExternal(url);
    } else {
      console.log(`[Navigation] Allowed: ${url}`);
    }
  });

  // Detect successful login and navigate to Messenger
  view.webContents.on('did-navigate', (_event, url) => {
    void handleMessengerNavigation(view, url);
  });

  // Handle new window requests (for calls, media, etc.)
  view.webContents.setWindowOpenHandler(({ url, frameName }) => {
    console.log(`[Window] New window requested: ${url}, frame: ${frameName}`);

    // Allow about:blank (used by Messenger for calls/popups)
    if (url === 'about:blank' || url.startsWith('about:')) {
      console.log(`[Window] Allowing about: URL`);
      return { action: 'allow' };
    }

    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname;

      // Only allow messenger.com to stay in the app
      const allowedPatterns = [
        /^(www\.)?messenger\.com$/,
        /^.*\.messenger\.com$/,
        /^.*\.fbcdn\.net$/,
      ];

      const isAllowed = allowedPatterns.some(pattern => pattern.test(hostname));

      if (isAllowed && (url.includes('/videocall') || url.includes('/call') || url.includes('/room'))) {
        // Allow calls to open in new window
        console.log(`[Window] Allowing call window: ${url}`);
        return { action: 'allow' };
      } else if (isAllowed) {
        // Other allowed domains, load in the current view
        console.log(`[Window] Loading in current view: ${url}`);
        void view.webContents.loadURL(url);
        return { action: 'deny' };
      } else {
        // External URLs open in browser
        console.log(`[Window] Opening externally: ${url}`);
        void shell.openExternal(url);
        return { action: 'deny' };
      }
    } catch (error) {
      console.error(`[Window] Error parsing URL: ${url}`, error);
      return { action: 'deny' };
    }
  });

  // Handle child windows (for calls)
  view.webContents.on('did-create-window', (childWindow, details) => {
    console.log('[BrowserView] Child window created:', details.url);

    // Apply theme colors to call window
    const themeColors: Record<string, string> = {
      'dark': '#1a1d29',
      'light': '#f8fafc',
      'lush-forest': '#064e3b',
      'contrast': '#000000',
      'desert': '#7c2d12',
      'electric': '#4c1d95'
    };
    const bgColor = themeColors[currentTheme] || themeColors['dark'];
    childWindow.setBackgroundColor(bgColor);

    // Set custom icon for call window
    // In packaged app, assets are in the asar, so use path relative to app
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');

    try {
      childWindow.setIcon(iconPath);
      console.log('[ChildWindow] Custom icon set:', iconPath);
    } catch (error) {
      console.warn('[ChildWindow] Failed to set icon:', error);
      // Icon setting is not critical, continue without it
    }

    // Configure child window for media access
    childWindow.webContents.session.setPermissionRequestHandler(
      (_webContents, permission, callback) => {
        console.log(`[ChildWindow] Permission request: ${permission}`);

        // Allow media permissions for calls
        const allowedPermissions = [
          'media',
          'mediaKeySystem',
          'notifications',
          'clipboard-read',
          'clipboard-sanitized-write',
          'fullscreen',
          'display-capture',  // Screen sharing
        ];

        if (allowedPermissions.includes(permission)) {
          callback(true);
        } else {
          console.warn(`[ChildWindow] Denied permission: ${permission}`);
          callback(false);
        }
      }
    );

    // Handle screen sharing requests (dialog parented to the call window)
    childWindow.webContents.session.setDisplayMediaRequestHandler(
      (_request, callback) => {
        console.log('[ChildWindow] Screen sharing request received');
        handleDisplayMediaRequest(callback, childWindow);
      }
    );

    // Handle child window navigation
    childWindow.webContents.on('will-navigate', (event, url) => {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname;

      const allowedPatterns = [
        /^(www\.)?messenger\.com$/,
        /^(www\.)?facebook\.com$/,
        /^.*\.messenger\.com$/,
        /^.*\.facebook\.com$/,
        /^.*\.fbcdn\.net$/,
      ];

      const isAllowed = allowedPatterns.some(pattern => pattern.test(hostname));

      if (!isAllowed) {
        console.log(`[ChildWindow] Blocked navigation: ${url}`);
        event.preventDefault();
      }
    });

    // Inject theme CSS and auto-scroll into call window
    childWindow.webContents.on('did-finish-load', () => {
      console.log('[ChildWindow] Page loaded, injecting theme CSS and auto-scroll');
      childWindow.webContents.insertCSS(getThemeCSS(currentTheme)).catch((error: unknown) => {
        console.error('[ChildWindow] Failed to inject theme CSS:', error);
      });
    });
  });

  // Handle page load events
  view.webContents.on('did-finish-load', () => {
    console.log('[MessengerView] Page loaded');
    void injectCustomCSS(view, currentTheme);
    void injectAutoScrollJS(view);
    void injectNotificationClickHandler(view);
  });

  // Handle page load errors
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[MessengerView] Load failed: ${errorCode} - ${errorDescription}`);
    // Could show an error page here
  });

  // Handle crashes
  view.webContents.on('render-process-gone', (_event, details) => {
    console.error('[MessengerView] Renderer crashed:', details.reason);
    // Attempt to recover by reloading
    if (details.reason !== 'killed') {
      setTimeout(() => {
        if (!view.webContents.isDestroyed()) {
          view.webContents.reload();
        }
      }, 1000);
    }
  });

  // Handle certificate errors (production should be strict)
  view.webContents.on('certificate-error', (_event, url, error) => {
    console.error(`[MessengerView] Certificate error for ${url}: ${error}`);
    // In production, do NOT bypass certificate errors
    // event.preventDefault() would bypass - we intentionally don't call it
  });

  // Native right-click menu (spellcheck, clipboard, links, images)
  setupContextMenu(view);

  console.log('[MessengerView] Created with secure defaults');
  return view;
}

/**
 * Attach the messenger view to the window and manage bounds.
 * WebContentsView has no setAutoResize, so bounds are recalculated on
 * every window size change.
 */
function attachMessengerView(window: BrowserWindow, view: WebContentsView): void {
  window.contentView.addChildView(view);

  const TITLE_BAR_HEIGHT = 40; // Custom title bar height

  // Calculate bounds (full window minus custom title bar)
  const updateBounds = () => {
    const bounds = window.getContentBounds();
    view.setBounds({
      x: 0,
      y: TITLE_BAR_HEIGHT,
      width: bounds.width,
      height: bounds.height - TITLE_BAR_HEIGHT,
    });
  };

  // Update bounds on any window size change
  window.on('resize', updateBounds);
  window.on('maximize', updateBounds);
  window.on('unmaximize', updateBounds);
  window.on('enter-full-screen', updateBounds);
  window.on('leave-full-screen', updateBounds);

  // Initial bounds
  updateBounds();

  console.log('[MessengerView] Attached to window with custom title bar offset');
}

// ═══════════════════════════════════════════════════════════════════
// MAIN WINDOW CREATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Create the main application window.
 */
function createMainWindow(): BrowserWindow {
  // Get saved window state
  const windowState = getWindowState();

  const window = new BrowserWindow({
    // Size and position from saved state
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    
    // Minimum size
    minWidth: 400,
    minHeight: 300,
    
    // Window chrome - frameless for custom title bar
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    
    // Show when ready
    show: false,
    backgroundColor: '#ffffff',
    title: 'Messenger Desktop',

    // Icon
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    
    // Web preferences for the window itself (for title bar)
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: getTitleBarPreloadPath(),
    },
  });

  // Load custom title bar
  // In both dev and packaged, the path is relative to the dist folder
  const titleBarPath = path.join(__dirname, '..', 'renderer', 'titlebar.html');

  console.log('[Window] Loading title bar from:', titleBarPath);
  window.loadFile(titleBarPath).catch((error: unknown) => {
    console.error('[Window] Failed to load title bar:', error);
    console.error('[Window] Attempted path:', titleBarPath);
  });

  // Attach window state persistence
  attachWindowStateListeners(window);

  // Show when ready
  window.once('ready-to-show', () => {
    restoreWindowState(window);
    if (!window.isVisible()) {
      window.show();
    }
    console.log('[Window] Ready and shown');
  });

  // Fallback: show window after a short delay if ready-to-show hasn't fired
  // This can happen when the window doesn't load content directly (using BrowserView instead)
  setTimeout(() => {
    if (!window.isVisible() && !window.isDestroyed()) {
      restoreWindowState(window);
      window.show();
      console.log('[Window] Shown (fallback)');
    }
  }, 100);

  // Handle window focus for notifications
  window.on('focus', () => {
    notifyFocusChange(true);
  });

  window.on('blur', () => {
    notifyFocusChange(false);
  });

  // Handle close to tray (configurable by user)
  window.on('close', (event) => {
    const shouldMinimizeToTray = getMinimizeToTray();
    const isQuitting =
      (app as unknown as { isQuitting?: boolean }).isQuitting === true;

    if (shouldMinimizeToTray && !isQuitting) {
      event.preventDefault();
      window.hide();
      console.log('[Window] Minimized to tray (close behavior: minimize to tray)');
    } else {
      console.log('[Window] Closing app (close behavior: quit app)');
    }
  });

  console.log('[Window] Created');
  return window;
}

// Removed unused login window functions - using simplified direct login approach

// ═══════════════════════════════════════════════════════════════════
// APPLICATION LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

/**
 * Initialize the application.
 */
async function initializeApp(): Promise<void> {
  console.log('[App] Initializing...');
  console.log(`[App] Electron: ${process.versions.electron}`);
  console.log(`[App] Chrome: ${process.versions.chrome}`);
  console.log(`[App] Node: ${process.versions.node}`);
  console.log(`[App] Platform: ${process.platform}`);

  // Resolve the saved theme setting (may be 'auto')
  currentTheme = resolveTheme(settings.getTheme());

  // Re-resolve when the OS theme changes and the user chose 'auto'
  nativeTheme.on('updated', () => {
    if (settings.getTheme() === 'auto') {
      handleThemeChange('auto');
    }
  });

  // Configure session
  const messengerSession = configureSession();

  // Create main window
  mainWindow = createMainWindow();

  // Register IPC handlers
  registerIpcHandlers(mainWindow);

  // Initialize tray
  initializeTray(mainWindow);

  // Create and attach the messenger view
  messengerView = createMessengerView(messengerSession);
  attachMessengerView(mainWindow, messengerView);

  // Create application menu
  createApplicationMenu(mainWindow);
  setMessengerView(messengerView);

  // Set up zoom functions for IPC handlers
  setZoomFunctions(zoomIn, zoomOut, zoomReset);

  // Set up theme change callback
  setThemeChangeCallback(handleThemeChange);

  // Set up go to home callback
  setGoToHomeCallback(handleGoToHome);

  // Start the auto-updater (no-op in development / on unsupported platforms)
  initializeAutoUpdater(() => mainWindow);

  // Load Messenger. Login detection lives in createMessengerView's
  // did-navigate handler, so first launch and returning users share
  // the same path.
  console.log(`[App] Loading ${MESSENGER_URL}`);
  await messengerView.webContents.loadURL(MESSENGER_URL);

  // Show main window
  mainWindow.show();

  console.log('[App] Initialized successfully');
}

/**
 * Clean up application resources.
 */
function cleanupApp(): void {
  console.log('[App] Cleaning up...');

  // Unregister IPC handlers
  unregisterIpcHandlers();

  // Destroy tray
  destroyTray();

  // Clear references
  messengerView = null;
  mainWindow = null;

  console.log('[App] Cleanup complete');
}

// ═══════════════════════════════════════════════════════════════════
// ELECTRON APP EVENTS
// ═══════════════════════════════════════════════════════════════════

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('[App] Another instance is running, quitting');
  app.quit();
} else {
  // Handle second instance
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // App ready
  app.whenReady().then(initializeApp).catch((error: unknown) => {
    console.error('[App] Initialization failed:', error);
    app.quit();
  });

  // All windows closed
  app.on('window-all-closed', () => {
    // On macOS, apps typically stay open until explicit quit
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Activate (macOS dock click)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void initializeApp();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });

  // Before quit
  app.on('before-quit', () => {
    // Mark that we're quitting (for minimize-to-tray behavior)
    (app as unknown as { isQuitting?: boolean }).isQuitting = true;
  });

  // Quit
  app.on('quit', () => {
    cleanupApp();
  });
}

// ═══════════════════════════════════════════════════════════════════
// SECURITY: DISABLE DANGEROUS ELECTRON FEATURES
// ═══════════════════════════════════════════════════════════════════

// Disable navigation to file:// URLs
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) {
      event.preventDefault();
      console.warn('[Security] Blocked file:// navigation:', url);
    }
  });

  // Disable new window creation except through our handler
  contents.setWindowOpenHandler(({ url }) => {
    // Only allow specific URLs to open in new windows
    void shell.openExternal(url);
    return { action: 'deny' };
  });
});


