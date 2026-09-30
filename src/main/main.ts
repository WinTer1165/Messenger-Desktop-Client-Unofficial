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
import * as dnd from './do-not-disturb';
import {
  unwrapRedirectUrl,
  isInAppUrl,
  isPopupUrl,
  isCallUrl,
  openInBrowser,
} from './navigation';
import { initializeAutoUpdater } from './updater';
import {
  getWindowState,
  attachWindowStateListeners,
  restoreWindowState,
} from './window-manager';
import { initializeTray, destroyTray, refreshContextMenu } from './tray';
import {
  registerIpcHandlers,
  unregisterIpcHandlers,
  notifyFocusChange,
  sendToRenderer,
  setZoomFunctions,
  setThemeChangeCallback,
  setGoToHomeCallback,
  setForgotPinCallback,
  getMinimizeToTray,
} from './ipc-handlers';
import * as connectivity from './connectivity';
import * as notifications from './notifications';
import * as appLock from './app-lock';
import { attachOverlays, setOverlay } from './overlays';
import { initializeAppDialogs, showAppDialog } from './app-dialog';
import { startStorageMaintenance, stopStorageMaintenance } from './storage';
import {
  createApplicationMenu,
  registerShortcuts,
  setMessengerView,
  setOpenSettingsHandler,
  zoomIn,
  zoomOut,
  zoomReset,
} from './menu';

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

/**
 * Windows files notifications and taskbar buttons under an App User
 * Model ID. Must match `appId` in electron-builder.yml, which the
 * installer stamps on the Start Menu shortcut: then toasts show the
 * app's name and icon instead of a generated "electron.app.*" ID, and
 * the running window groups with a pinned taskbar shortcut.
 */
const APP_USER_MODEL_ID = 'com.messenger-desktop-unofficial';

// Unpackaged runs have no shortcut carrying the ID, so they keep
// Electron's default
if (process.platform === 'win32' && app.isPackaged) {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

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
      if (permission === 'notifications' && dnd.isEnabled()) {
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
    if (permission === 'notifications' && dnd.isEnabled()) {
      return false;
    }
    return true;
  });

  // Block unwanted content (ads, tracking). Chromium matches the URL
  // filter itself, so only requests being blocked ever reach this
  // callback - listening on every URL made each of Messenger's requests
  // wait on a round trip through the main process.
  const blockedUrls = [
    '*://*.doubleclick.net/*',
    '*://*.googlesyndication.com/*',
    '*://*.facebook.com/tr/*', // Facebook pixel
    '*://*.fbsbx.com/*',       // Some FB tracking
  ];

  messengerSession.webRequest.onBeforeRequest(
    { urls: blockedUrls },
    (details, callback) => {
      console.log(`[Session] Blocked: ${details.url}`);
      callback({ cancel: true });
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
 * - Hides the page-level scrollbar at the window edge
 * - Hides promotional banners
 */
const CUSTOM_CSS = `
/* Custom styles for Messenger Desktop Wrapper - Minimal changes only */

/* Hide the page-level scrollbar at the window edge (messenger.com sets
   overflow-y: scroll on body, which puts one on the viewport). Only the
   root is targeted - scrollbar-width is not inherited - so Messenger's
   own scroll areas keep theirs, and the page still scrolls by wheel. */
html {
  scrollbar-width: none !important;
}
html::-webkit-scrollbar,
body::-webkit-scrollbar {
  display: none !important;
}

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
 * The logged-out page puts the login form bottom-left under a huge
 * headline, so in a normal-sized window the form ends up cut off at the
 * bottom. While it's showing, the form's column is centered in the
 * window instead, on a plain white page.
 *
 * Everything is scoped to html.mdw-login, which LOGIN_PAGE_SCRIPT only
 * sets when the page looks as expected - otherwise Facebook's own layout
 * stays untouched.
 */
const LOGIN_PAGE_CSS = `
html.mdw-login,
html.mdw-login body {
  overflow: hidden !important;
}
html.mdw-login body::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  background: #fff;
}
html.mdw-login .mdw-login-column {
  position: fixed !important;
  z-index: 2147483001 !important;
  inset: 0 !important;
  margin: auto !important;
  width: min(400px, calc(100vw - 48px)) !important;
  height: fit-content !important;
  max-height: calc(100vh - 40px) !important;
  overflow-y: auto !important;
  scrollbar-width: none !important;
  padding: 0 !important;
}
html.mdw-login .mdw-login-column h1 {
  margin: 0 0 12px !important;
  font-size: 34px !important;
  line-height: 1.15 !important;
  text-align: center !important;
}
html.mdw-login .mdw-login-column p {
  margin: 0 0 20px !important;
  font-size: 15px !important;
  line-height: 1.45 !important;
  text-align: center !important;
}
html.mdw-login #login_form input[type="text"],
html.mdw-login #login_form input[type="password"] {
  width: 100% !important;
  box-sizing: border-box !important;
}
html.mdw-login #login_form div:has(> #loginbutton) {
  justify-content: center !important;
}
/* The checkbox is placed absolutely inside its row, so the row is
   shrunk to fit and centered rather than re-laid out */
html.mdw-login #login_form div:has(> label input[type="checkbox"]) {
  width: fit-content !important;
  margin-left: auto !important;
  margin-right: auto !important;
}
/* Short windows: a smaller headline and no blurb, so the whole form fits */
@media (max-height: 600px) {
  html.mdw-login .mdw-login-column h1 {
    margin-bottom: 16px !important;
    font-size: 26px !important;
  }
  html.mdw-login .mdw-login-column p {
    display: none !important;
  }
}
`;

/**
 * Marks the login page for LOGIN_PAGE_CSS - only the plain landing page.
 *
 * After Log In the page normally moves on to Messenger by itself, so the
 * layout stays put while that happens (switching back straight away made
 * the page jump). But Facebook can also ask for its next step on this
 * same page ("Continue as…", a two-factor code, "check your other
 * device"), and the white backdrop would hide it - the login looked like
 * it had done nothing. So if the page is still here a few seconds after
 * Log In, Facebook's own layout comes back for good.
 *
 * It also steps aside while something else has to be seen (a cookie
 * consent dialog, an error outside the form's column), and when the
 * page doesn't look as expected at all.
 */
const LOGIN_PAGE_SCRIPT = `
  (function() {
    if (window.__mdwLoginLayout) return;
    window.__mdwLoginLayout = true;

    // The landing page only - never the pages the login leads to
    if (!['/', '/login', '/login/'].includes(location.pathname)) return;

    const form = document.getElementById('login_form');
    if (!form) return;

    // The column holding the headline, the blurb and the form
    let column = form.parentElement;
    while (column && column !== document.body && !column.querySelector('h1')) {
      column = column.parentElement;
    }
    if (!column || column === document.body || column.querySelectorAll('h1').length !== 1) return;
    column.classList.add('mdw-login-column');

    // Still on this page this long after Log In: Facebook wants something here
    const GIVE_WAY_AFTER_MS = 6000;

    let gaveWay = false;
    let attemptTimer = null;
    const observer = new MutationObserver(update);

    function update() {
      const somethingElseShowing = [...document.querySelectorAll('[role="dialog"], [role="alert"], #error_box')]
        .some((el) => !column.contains(el) && el.getClientRects().length > 0);
      const useLayout = !gaveWay && form.isConnected && !somethingElseShowing;

      document.documentElement.classList.toggle('mdw-login', useLayout);
      if (gaveWay) {
        observer.disconnect();
      }
    }

    // Capture phase, so this runs before Facebook's own handlers
    const onLogInAttempt = () => {
      if (attemptTimer) return;
      attemptTimer = setTimeout(() => {
        gaveWay = true;
        update();
      }, GIVE_WAY_AFTER_MS);
    };
    form.addEventListener('submit', onLogInAttempt, true);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') onLogInAttempt();
    }, true);
    const logInButton = document.getElementById('loginbutton');
    if (logInButton) {
      logInButton.addEventListener('click', onLogInAttempt, true);
    }

    update();
    observer.observe(document.body, { childList: true, subtree: true });
  })();
`;

/**
 * Center the login form (see LOGIN_PAGE_CSS). Does nothing on any other
 * page.
 */
async function injectLoginLayout(view: WebContentsView): Promise<void> {
  try {
    await view.webContents.insertCSS(LOGIN_PAGE_CSS);
    await view.webContents.executeJavaScript(LOGIN_PAGE_SCRIPT);
  } catch (error) {
    console.error('[LoginLayout] Failed to inject:', error);
  }
}

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

        // Searching for the container reads layout on many elements, so
        // while none is found, search at most this often
        const SEARCH_INTERVAL = 1000; // ms
        let lastSearchTime = 0;

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
            const now = Date.now();
            if (now - lastSearchTime < SEARCH_INTERVAL) {
              return;
            }
            lastSearchTime = now;
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

          // Messenger mutates this subtree constantly (hover toolbars,
          // typing indicators), so batch the checks to one per frame.
          // Frames don't run while the window is hidden, which pauses
          // the work in the background too.
          let checkQueued = false;
          observer = new MutationObserver((mutations) => {
            if (checkQueued) return;

            // Only added nodes (new messages) matter
            if (!mutations.some((mutation) => mutation.addedNodes.length > 0)) return;

            checkQueued = true;
            requestAnimationFrame(() => {
              checkQueued = false;
              scrollToBottom(true);
            });
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
 * Inject the notification patch (see notifications.ts), which relays
 * Messenger's notifications to be shown natively. Messenger's own click
 * handling still runs - events are relayed back to the page.
 *
 * Runs in the page's main world, where the contextBridge API
 * (window.messengerBridge) is available.
 */
async function injectNotificationPatch(view: WebContentsView): Promise<void> {
  try {
    await view.webContents.executeJavaScript(notifications.getPageScript());
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
function handleThemeChange(theme: ThemeSetting): void {
  settings.setTheme(theme);
  currentTheme = resolveTheme(theme);
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

/** Chromium's net::ERR_ABORTED - a navigation we cancelled ourselves. */
const ERR_ABORTED = -3;

/**
 * Safety net for the chat view: if a blocked hop or a failed load left
 * it somewhere that isn't Messenger, send it back. Without this the
 * window stays blank until the user presses Home.
 */
function restoreIfStranded(view: WebContentsView): void {
  if (view.webContents.isDestroyed()) return;

  const current = view.webContents.getURL();

  // Still on Messenger (or Facebook login) - nothing to recover
  if (current && isInAppUrl(current)) return;

  console.log(
    `[Navigation] View stranded on ${current || '(nothing)'} - returning to Messenger`
  );
  view.webContents.loadURL(MESSENGER_URL).catch((error: unknown) => {
    console.error('[Navigation] Failed to return to Messenger:', error);
  });
}

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

  // Navigation policy: Messenger and Facebook render in-app, everything
  // else goes to the browser. Redirects are covered too, because that is
  // how Messenger's link shim reaches the real target.
  const applyNavigationPolicy = (event: Electron.Event, url: string): void => {
    const target = unwrapRedirectUrl(url);

    if (isInAppUrl(target)) {
      // Skip the shim and load the destination directly, so the view is
      // never left sitting on a blank interstitial
      if (target !== url) {
        console.log(`[Navigation] Following shim to: ${target}`);
        event.preventDefault();
        view.webContents.loadURL(target).catch((error: unknown) => {
          console.error('[Navigation] Failed to follow shim:', error);
        });
      }
      return;
    }

    event.preventDefault();
    openInBrowser(target);
    restoreIfStranded(view);
  };

  view.webContents.on('will-navigate', (event, url) => applyNavigationPolicy(event, url));
  view.webContents.on('will-redirect', (event, url) => applyNavigationPolicy(event, url));

  // Detect successful login and navigate to Messenger. A committed page
  // also means the network works, which ends the offline screen.
  view.webContents.on('did-navigate', (_event, url) => {
    connectivity.handleNavigated();
    void handleMessengerNavigation(view, url);
  });

  // Handle new window requests (for calls, media, etc.)
  view.webContents.setWindowOpenHandler(({ url, frameName }) => {
    console.log(`[Window] New window requested: ${url}, frame: ${frameName}`);

    // Allow about:blank (used by Messenger for calls/popups)
    if (url.startsWith('about:')) {
      console.log('[Window] Allowing about: URL');
      return { action: 'allow' };
    }

    const target = unwrapRedirectUrl(url);

    // Anything that isn't Messenger's own UI goes to the browser.
    // This must not touch the chat view: navigating it onto a link shim
    // is what used to leave the window blank until Home was pressed.
    if (!isPopupUrl(target)) {
      openInBrowser(target);
      return { action: 'deny' };
    }

    if (isCallUrl(target)) {
      console.log(`[Window] Allowing call window: ${target}`);
      return { action: 'allow' };
    }

    console.log(`[Window] Loading in current view: ${target}`);
    view.webContents.loadURL(target).catch((error: unknown) => {
      console.error('[Window] Failed to load in current view:', error);
    });
    return { action: 'deny' };
  });

  // Handle child windows (for calls)
  view.webContents.on('did-create-window', (childWindow, details) => {
    console.log('[BrowserView] Child window created:', details.url);

    // Count it as a call (notifications can pause during calls)
    notifications.trackCallWindow(childWindow);

    // Apply theme colors to call window
    const themeColors: Record<string, string> = {
      'dark': '#1a1d29',
      'light': '#f8fafc',
      'lush-forest': '#064e3b',
      'contrast': '#000000',
      'desert': '#7c2d12',
      'electric': '#4c1d95',
      'northern-lights': '#07141a',
      'sakura-bloom': '#fff5fa',
      'deep-ocean': '#04111f',
      'cosmic-nebula': '#10061d',
      'sunset-drive': '#150f2e',
      'arctic-frost': '#f4faff',
      'neon-city': '#07070d',
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

    // Handle child window navigation - same policy as the main view, so
    // a link clicked during a call opens in the browser instead of
    // hijacking (or blanking) the call window
    const applyChildNavigationPolicy = (event: Electron.Event, url: string): void => {
      const target = unwrapRedirectUrl(url);
      if (isInAppUrl(target)) return;

      console.log(`[ChildWindow] Navigation sent to browser: ${target}`);
      event.preventDefault();
      openInBrowser(target);
    };

    childWindow.webContents.on('will-navigate', (event, url) =>
      applyChildNavigationPolicy(event, url)
    );
    childWindow.webContents.on('will-redirect', (event, url) =>
      applyChildNavigationPolicy(event, url)
    );

    // Inject theme CSS and auto-scroll into call window
    childWindow.webContents.on('did-finish-load', () => {
      console.log('[ChildWindow] Page loaded, injecting theme CSS and auto-scroll');
      childWindow.webContents.insertCSS(getThemeCSS(currentTheme)).catch((error: unknown) => {
        console.error('[ChildWindow] Failed to inject theme CSS:', error);
      });
    });
  });

  // Styles and the notification patch go in as soon as the DOM exists,
  // so the page never flashes the edge scrollbar or promo banners while
  // it loads, and no early notification slips past the patch
  view.webContents.on('dom-ready', () => {
    void injectCustomCSS(view, currentTheme);
    void injectNotificationPatch(view);
    void injectLoginLayout(view);
  });

  // Handle page load events
  view.webContents.on('did-finish-load', () => {
    console.log('[MessengerView] Page loaded');
    void injectAutoScrollJS(view);
  });

  // Handle page load errors
  view.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error(
        `[MessengerView] Load failed: ${errorCode} - ${errorDescription} (${validatedURL})`
      );

      // ERR_ABORTED is what our own preventDefault() produces; the view
      // still holds its previous page, so there is nothing to recover
      if (!isMainFrame || errorCode === ERR_ABORTED) {
        return;
      }

      // No network (or not yet, after waking): show the offline screen,
      // which reloads Messenger once the connection is back
      if (isInAppUrl(validatedURL) && connectivity.handleLoadFailure(errorCode)) {
        return;
      }

      restoreIfStranded(view);
    }
  );

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
  // The theme and lock state ride along so the first frame is already
  // right - no flash of the default theme, no gap before the lock screen
  window.loadFile(titleBarPath, {
    query: {
      theme: currentTheme,
      locked: appLock.isLockSetUp() ? '1' : '0',
    },
  }).catch((error: unknown) => {
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

  // Handle window focus for notifications. Cards on screen have done
  // their job once the user is looking at the app.
  window.on('focus', () => {
    notifyFocusChange(true);
    notifications.closeAllNotifications();
  });

  window.on('blur', () => {
    notifyFocusChange(false);
  });

  // Keep the title bar's maximize/restore glyph in step
  window.on('maximize', () => sendToRenderer('window-maximized-changed', true));
  window.on('unmaximize', () => sendToRenderer('window-maximized-changed', false));

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
 * Open the settings page (tray menu, Ctrl/Cmd+,): bring the window up
 * and let the title bar document show it.
 */
function openSettings(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  sendToRenderer('open-settings');
}

/**
 * Push the current settings to the title bar document. Module-level so
 * re-initialising (macOS) doesn't register it twice.
 */
function broadcastSettings(): void {
  sendToRenderer('settings-changed', settings.getSnapshot());
}

/**
 * The app lock engaged or released: cover or uncover Messenger.
 */
function handleLockChange(locked: boolean): void {
  setOverlay('lock', locked);
  if (locked) {
    // The settings page must not stay reachable behind the lock, and
    // cards already on screen may show names and text
    setOverlay('settings', false);
    notifications.closeAllNotifications();
  }

  sendToRenderer('lock-state-changed', locked);
  refreshContextMenu();
}

/**
 * Sign out of Messenger on this computer: every login, remembered
 * account and piece of chat data in the Messenger session goes.
 *
 * Messenger is unloaded first, so none of the old session stays on
 * screen and nothing is open that could write it back while it is being
 * cleared - the page keeps chats in local databases, and a still-loaded
 * page is what used to bring them straight back. Ends on the login page.
 *
 * The session stays valid on Facebook's side until it expires; it can
 * be ended there under "Where you're logged in".
 */
async function signOutOfMessenger(view: WebContentsView): Promise<void> {
  const ses = view.webContents.session;
  console.log('[SignOut] Signing out of Messenger');

  await view.webContents.loadURL('about:blank').catch(() => {
    // Leaving the page is all that matters here
  });

  await ses.clearStorageData();
  await Promise.all([ses.clearCache(), ses.clearAuthCache(), ses.clearCodeCaches({})]);

  // No login cookie may survive, whatever clearStorageData missed
  for (const cookie of await ses.cookies.get({})) {
    const host = (cookie.domain ?? '').replace(/^\./, '');
    await ses.cookies
      .remove(`https://${host}${cookie.path ?? '/'}`, cookie.name)
      .catch(() => {
        // Already gone
      });
  }
  await ses.cookies.flushStore();
  settings.setHasLoggedIn(false);

  const leftover = (await ses.cookies.get({})).length;
  console.log(`[SignOut] Session cleared (${leftover} cookies left)`);

  // Straight to the login page - without a network, the offline screen
  await view.webContents.loadURL(MESSENGER_URL).catch((error: unknown) => {
    console.warn('[SignOut] Login page did not load:', error);
  });
}

/**
 * "Forgot PIN?" on the lock screen: without the PIN, the only way in is
 * to sign out. Asks first; the lock screen stays up until the login
 * page is showing.
 *
 * @returns whether the user went ahead
 */
async function handleForgotPin(): Promise<boolean> {
  if (!messengerView || !appLock.isLocked()) return false;

  const response = await showAppDialog({
    type: 'warning',
    title: 'Forgot your PIN?',
    message: 'Sign out to remove the lock.',
    detail:
      'Without the PIN, the only way back in is to sign out of Messenger on this computer. ' +
      'This removes your login, saved accounts and the chat data stored here. ' +
      'You can sign in again right after.',
    buttons: ['Cancel', 'Sign out'],
    defaultId: 0,
    cancelId: 0,
    dangerId: 1,
  });
  if (response !== 1) return false;

  await signOutOfMessenger(messengerView);
  appLock.resetAfterSignOut();
  return true;
}

/**
 * Initialize the application.
 */
function initializeApp(): void {
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
  initializeTray(mainWindow, openSettings);

  // Messenger's notifications are shown natively (see notifications.ts)
  notifications.initializeNotifications(mainWindow);

  // Create and attach the messenger view
  messengerView = createMessengerView(messengerSession);
  attachMessengerView(mainWindow, messengerView);

  // The offline screen, settings page, lock screen and app dialogs take
  // Messenger's place by hiding the view (see overlays.ts)
  attachOverlays(mainWindow, messengerView);
  initializeAppDialogs(mainWindow, messengerView);

  // App lock - locks right away if one is set up, before anything of
  // Messenger is visible
  appLock.initializeAppLock(mainWindow, handleLockChange);

  // Create application menu
  createApplicationMenu(mainWindow);
  setMessengerView(messengerView);

  // Keyboard shortcuts have to be bound to every focusable surface: the
  // title bar and the Messenger view are separate webContents, and only
  // the focused one receives key events
  registerShortcuts(mainWindow.webContents);
  registerShortcuts(messengerView.webContents);

  // Set up zoom functions for IPC handlers
  setZoomFunctions(zoomIn, zoomOut, zoomReset);

  // Set up theme change callback
  setThemeChangeCallback(handleThemeChange);

  // Set up go to home callback
  setGoToHomeCallback(handleGoToHome);

  // "Forgot PIN?" on the lock screen signs out
  setForgotPinCallback(handleForgotPin);

  // Ctrl/Cmd+, opens the settings page
  setOpenSettingsHandler(openSettings);

  // Keep the settings page (and title bar) in step with every change
  settings.onChange(broadcastSettings);

  // Start the auto-updater (no-op in development / on unsupported platforms)
  initializeAutoUpdater();

  // Offline screen: hide the chat view when Messenger can't be reached
  // and let the title bar show the offline screen
  connectivity.initializeConnectivity(messengerView, (status) => {
    setOverlay('offline', status.state !== 'online');
    sendToRenderer('connection-status-changed', status);
  });

  // Keep the V8 code cache from growing without bound
  startStorageMaintenance(messengerSession);

  // Load Messenger. Login detection lives in createMessengerView's
  // did-navigate handler, so first launch and returning users share
  // the same path. Not awaited: with no network yet (Wi-Fi down, just
  // woke up) the load fails, and the offline screen takes it from
  // there - a failed load must never abort startup.
  console.log(`[App] Loading ${MESSENGER_URL}`);
  messengerView.webContents.loadURL(MESSENGER_URL).catch((error: unknown) => {
    console.warn('[App] Initial load did not complete:', error);
  });

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

  // Stop background timers
  connectivity.stopConnectivity();
  stopStorageMaintenance();
  appLock.stopAppLock();
  notifications.stopNotifications();

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
      initializeApp();
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

  // Disable new window creation except through our handler.
  // The messenger view replaces this with its own handler right after
  // it is constructed; this is the fallback for everything else.
  contents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
});


