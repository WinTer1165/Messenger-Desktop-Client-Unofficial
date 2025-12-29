/**
 * Main Process Entry Point
 * 
 * This is the entry point for the Electron main process.
 * It orchestrates:
 * - Application lifecycle (ready, quit, activate)
 * - BrowserWindow creation with secure defaults
 * - BrowserView attachment for messenger.com
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
  BrowserView,
  session,
  shell,
  WebContents,
  dialog,
} from 'electron';
import * as path from 'path';
import ElectronStore from 'electron-store';
import {
  MESSENGER_URL,
  SESSION_PARTITION,
  USER_AGENT,
} from '../shared/types';
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
} from './ipc-handlers';
import { createApplicationMenu, setMessengerView, zoomIn, zoomOut, zoomReset } from './menu';

// ═══════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════

let mainWindow: BrowserWindow | null = null;
let messengerView: BrowserView | null = null;
let currentTheme: string = 'dark';

// Persistent storage for user preferences
interface StoreSchema {
  hasLoggedIn: boolean;
}

const store = new ElectronStore<StoreSchema>({
  defaults: {
    hasLoggedIn: false,
  },
}) as ElectronStore<StoreSchema> & {
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K];
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void;
};

// Facebook login URL for first-time setup
const FACEBOOK_LOGIN_URL = 'https://www.facebook.com/login';

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

  // Set user agent to avoid bot detection
  messengerSession.setUserAgent(USER_AGENT);

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

  // Handle screen sharing requests
  messengerSession.setDisplayMediaRequestHandler((_request, callback) => {
    console.log('[Session] Screen share request');
    // Get all available screens and windows
    const { screen } = require('electron');
    const displays = screen.getAllDisplays();

    // Return all available screens for sharing
    callback({
      video: displays[0], // Primary display
      audio: 'loopback' as any // System audio
    });
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

  // Inject custom CSS to hide unwanted UI elements
  messengerSession.webRequest.onHeadersReceived(
    { urls: [`${MESSENGER_URL}/*`] },
    (details, callback) => {
      // Remove CSP to allow our injected scripts
      const responseHeaders = { ...details.responseHeaders };
      delete responseHeaders['Content-Security-Policy'];
      delete responseHeaders['content-security-policy'];
      callback({ responseHeaders });
    }
  );

  // Handle screen sharing requests
  messengerSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      console.log('[Session] Screen sharing request received');

      try {
        const { desktopCapturer } = await import('electron');
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });

        console.log(`[Session] Found ${sources.length} screen/window sources`);

        if (sources.length === 0) {
          callback({});
          return;
        }

        // Create picker options
        const screens = sources.filter(s => s.id.startsWith('screen:'));
        const windows = sources.filter(s => s.id.startsWith('window:'));

        const options: string[] = [];
        const sourceMap: { [key: number]: any } = {};
        let index = 0;

        // Add screens first
        screens.forEach(screen => {
          options.push(`🖥️ ${screen.name}`);
          sourceMap[index++] = screen;
        });

        // Add windows
        windows.forEach(window => {
          options.push(`🪟 ${window.name}`);
          sourceMap[index++] = window;
        });

        // Show picker dialog
        const result = await dialog.showMessageBox({
          type: 'question',
          title: 'Share Your Screen',
          message: 'Choose what to share:',
          buttons: [...options, 'Cancel'],
          defaultId: 0,
          cancelId: options.length,
        });

        if (result.response === options.length) {
          // User clicked Cancel
          callback({});
        } else {
          // User selected a source
          const selectedSource = sourceMap[result.response];
          console.log(`[Session] User selected: ${selectedSource.name}`);
          callback({ video: selectedSource });
        }
      } catch (error) {
        console.error('[Session] Failed to get desktop sources:', error);
        callback({});
      }
    }
  );

  console.log('[Session] Configured with partition:', SESSION_PARTITION);
  return messengerSession;
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
/* Custom styles for Messenger Desktop Wrapper */

/* Adjust for custom title bar (if using frameless window) */
/* Uncomment if you add a custom title bar:
body {
  padding-top: 32px !important;
}
*/

/* Hide "Get the Messenger app" banners */
[role="banner"] a[href*="messenger.com/desktop"],
[role="banner"] [data-testid*="download"] {
  display: none !important;
}

/* Hide promotional elements */
[data-testid="MWJewelThreadListContainer"] > div:first-child > div[role="banner"] {
  display: none !important;
}

/* Smooth scrolling for better UX */
* {
  scroll-behavior: smooth;
}

/* Remove focus outline */
:focus-visible {
  outline: none !important;
}
`;

/**
 * Generate theme-specific CSS for messenger content.
 */
function getThemeCSS(theme: string): string {
  const themes: Record<string, { bg: string; sidebar: string; text: string; accent: string; hover: string; glow: string }> = {
    'dark': {
      bg: 'linear-gradient(135deg, #1a1d29 0%, #2d3748 50%, #1e3a5f 100%)',
      sidebar: 'rgba(26, 29, 41, 0.95)',
      text: '#ffffff',
      accent: '#0084ff',
      hover: 'rgba(0, 132, 255, 0.15)',
      glow: 'rgba(0, 132, 255, 0.4)'
    },
    'light': {
      bg: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 50%, #cbd5e1 100%)',
      sidebar: 'rgba(248, 250, 252, 0.95)',
      text: '#1e293b',
      accent: '#0084ff',
      hover: 'rgba(0, 132, 255, 0.1)',
      glow: 'rgba(0, 132, 255, 0.3)'
    },
    'lush-forest': {
      bg: 'linear-gradient(135deg, #064e3b 0%, #047857 50%, #10b981 100%)',
      sidebar: 'rgba(6, 78, 59, 0.95)',
      text: '#ecfdf5',
      accent: '#34d399',
      hover: 'rgba(52, 211, 153, 0.15)',
      glow: 'rgba(52, 211, 153, 0.5)'
    },
    'contrast': {
      bg: 'linear-gradient(135deg, #000000 0%, #0f0f0f 50%, #1a1a1a 100%)',
      sidebar: 'rgba(0, 0, 0, 0.98)',
      text: '#00ff41',
      accent: '#00ff41',
      hover: 'rgba(0, 255, 65, 0.15)',
      glow: 'rgba(0, 255, 65, 0.6)'
    },
    'desert': {
      bg: 'linear-gradient(135deg, #7c2d12 0%, #ea580c 50%, #fb923c 100%)',
      sidebar: 'rgba(124, 45, 18, 0.95)',
      text: '#fffbeb',
      accent: '#fbbf24',
      hover: 'rgba(251, 191, 36, 0.15)',
      glow: 'rgba(251, 191, 36, 0.5)'
    },
    'electric': {
      bg: 'linear-gradient(135deg, #4c1d95 0%, #7c3aed 50%, #a78bfa 100%)',
      sidebar: 'rgba(76, 29, 149, 0.95)',
      text: '#faf5ff',
      accent: '#c084fc',
      hover: 'rgba(192, 132, 252, 0.15)',
      glow: 'rgba(192, 132, 252, 0.6)'
    }
  };

  const colors = themes[theme] || themes['dark'];

  return `
/* Theme: ${theme} - Only for call windows, not main Messenger content */

/* Remove focus rings (blue box fix) */
input:focus, textarea:focus, [contenteditable="true"]:focus,
div[role="textbox"]:focus {
  outline: none !important;
  box-shadow: none !important;
}

/* Call window specific styles */
div[class*="call"],
div[class*="video"],
div[class*="Call"],
div[class*="Video"] {
  background: ${colors.bg} !important;
}

/* Call controls background */
div[class*="callControls"],
div[class*="controls"],
div[class*="toolbar"],
div[class*="CallControls"] {
  background: ${colors.sidebar} !important;
  backdrop-filter: blur(20px) !important;
}

/* Video tiles/participants */
video {
  border-radius: 12px !important;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), 0 0 30px ${colors.glow} !important;
}

div[class*="participant"],
div[class*="tile"],
div[class*="Participant"],
div[class*="Tile"] {
  background: ${colors.sidebar} !important;
  border: 2px solid ${colors.accent}33 !important;
  border-radius: 12px !important;
  box-shadow: 0 4px 12px ${colors.glow} !important;
}

/* Call buttons */
button[class*="call"],
button[class*="CallButton"],
div[class*="callButton"] button {
  background: ${colors.hover} !important;
  border: 1px solid ${colors.accent}55 !important;
  color: ${colors.text} !important;
  box-shadow: 0 2px 8px ${colors.glow} !important;
}

button[class*="call"]:hover,
button[class*="CallButton"]:hover {
  background: ${colors.accent}44 !important;
  border-color: ${colors.accent} !important;
  transform: scale(1.05) !important;
  box-shadow: 0 4px 16px ${colors.glow} !important;
}

/* Mute/unmute, video on/off buttons */
button[aria-label*="mute"],
button[aria-label*="video"],
button[aria-label*="Mute"],
button[aria-label*="Video"] {
  background: ${colors.hover} !important;
  border: 1px solid ${colors.accent}55 !important;
}

/* End call button (red) - preserve its warning color but theme it */
button[aria-label*="end"],
button[aria-label*="End"],
button[aria-label*="leave"],
button[aria-label*="Leave"],
button[class*="danger"],
button[class*="Danger"] {
  background: #dc2626 !important;
  border-color: #991b1b !important;
}

button[aria-label*="end"]:hover,
button[aria-label*="End"]:hover,
button[aria-label*="leave"]:hover,
button[aria-label*="Leave"]:hover {
  background: #b91c1c !important;
  transform: scale(1.05) !important;
}

/* Participant names and labels */
div[class*="name"],
div[class*="label"],
span[class*="name"],
span[class*="label"] {
  color: ${colors.text} !important;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5) !important;
}

/* Modals and dialogs */
div[role="dialog"],
div[class*="modal"],
div[class*="Modal"] {
  background: ${colors.sidebar} !important;
  backdrop-filter: blur(20px) !important;
  border: 1px solid ${colors.accent}33 !important;
}

/* Tooltips */
div[role="tooltip"],
div[class*="tooltip"] {
  background: ${colors.sidebar} !important;
  color: ${colors.text} !important;
  border: 1px solid ${colors.accent}44 !important;
}

/* Scrollbar theming */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: ${colors.accent};
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: ${colors.accent}dd;
}

/* Selection color */
::selection {
  background: ${colors.accent}66 !important;
  color: ${colors.text} !important;
}

/* Focus indicators */
*:focus-visible {
  outline: 2px solid ${colors.accent} !important;
  outline-offset: 2px !important;
}
`;
}

/**
 * Inject custom CSS into the BrowserView.
 */
async function injectCustomCSS(view: BrowserView, theme: string = 'dark'): Promise<void> {
  try {
    await view.webContents.insertCSS(CUSTOM_CSS);
    await view.webContents.insertCSS(getThemeCSS(theme));
    console.log('[CSS] Custom styles injected with theme:', theme);
  } catch (error) {
    console.error('[CSS] Failed to inject styles:', error);
  }
}

/**
 * Handle theme change from titlebar.
 */
function handleThemeChange(theme: string): void {
  currentTheme = theme;
  console.log('[Theme] Changing theme to:', theme);

  // Re-inject CSS into messenger view
  if (messengerView && !messengerView.webContents.isDestroyed()) {
    messengerView.webContents.insertCSS(getThemeCSS(theme)).catch((error) => {
      console.error('[Theme] Failed to inject theme CSS:', error);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// BROWSERVIEW MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * Create and configure the BrowserView for messenger.com.
 * 
 * WHY BROWSERVIEW INSTEAD OF WEBVIEW TAG:
 * - BrowserView is out-of-process (more secure)
 * - webview tag is deprecated and has known security issues
 * - BrowserView integrates better with BrowserWindow lifecycle
 * - Easier to manage bounds and layering
 */
function createMessengerView(parentSession: Electron.Session): BrowserView {
  const view = new BrowserView({
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
      
      // Disable webview tag (we use BrowserView)
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
      shell.openExternal(url);
    } else {
      console.log(`[Navigation] Allowed: ${url}`);
    }
  });

  // Detect successful login and navigate to Messenger
  view.webContents.on('did-navigate', async (_event, url) => {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    const hasLoggedIn = store.get('hasLoggedIn');

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
            view.webContents.loadURL(MESSENGER_URL).catch((error) => {
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
        store.set('hasLoggedIn', true);
      }
    }
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
        view.webContents.loadURL(url);
        return { action: 'deny' };
      } else {
        // External URLs open in browser
        console.log(`[Window] Opening externally: ${url}`);
        shell.openExternal(url);
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

    // Handle screen sharing requests
    childWindow.webContents.session.setDisplayMediaRequestHandler(
      async (_request, callback) => {
        console.log('[ChildWindow] Screen sharing request received');

        try {
          const { desktopCapturer } = await import('electron');
          const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });

          console.log(`[ChildWindow] Found ${sources.length} screen/window sources`);

          if (sources.length === 0) {
            callback({});
            return;
          }

          // Create picker options
          const screens = sources.filter(s => s.id.startsWith('screen:'));
          const windows = sources.filter(s => s.id.startsWith('window:'));

          const options: string[] = [];
          const sourceMap: { [key: number]: any } = {};
          let index = 0;

          // Add screens first
          screens.forEach(screen => {
            options.push(`🖥️ ${screen.name}`);
            sourceMap[index++] = screen;
          });

          // Add windows
          windows.forEach(window => {
            options.push(`🪟 ${window.name}`);
            sourceMap[index++] = window;
          });

          // Show picker dialog
          const result = await dialog.showMessageBox(childWindow, {
            type: 'question',
            title: 'Share Your Screen',
            message: 'Choose what to share:',
            buttons: [...options, 'Cancel'],
            defaultId: 0,
            cancelId: options.length,
          });

          if (result.response === options.length) {
            // User clicked Cancel
            callback({});
          } else {
            // User selected a source
            const selectedSource = sourceMap[result.response];
            console.log(`[ChildWindow] User selected: ${selectedSource.name} (ID: ${selectedSource.id})`);
            // Pass the source with type assertion to bypass TypeScript checking
            callback({
              video: selectedSource as any
            });
          }
        } catch (error) {
          console.error('[ChildWindow] Failed to get desktop sources:', error);
          callback({});
        }
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

    // Inject theme CSS into call window
    childWindow.webContents.on('did-finish-load', () => {
      console.log('[ChildWindow] Page loaded, injecting theme CSS');
      childWindow.webContents.insertCSS(getThemeCSS(currentTheme)).catch((error) => {
        console.error('[ChildWindow] Failed to inject theme CSS:', error);
      });
    });
  });

  // Handle page load events
  view.webContents.on('did-finish-load', () => {
    console.log('[BrowserView] Page loaded');
    injectCustomCSS(view, currentTheme);
  });

  // Handle page load errors
  view.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[BrowserView] Load failed: ${errorCode} - ${errorDescription}`);
    // Could show an error page here
  });

  // Handle crashes
  view.webContents.on('render-process-gone', (_event, details) => {
    console.error('[BrowserView] Renderer crashed:', details.reason);
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
    console.error(`[BrowserView] Certificate error for ${url}: ${error}`);
    // In production, do NOT bypass certificate errors
    // event.preventDefault() would bypass - we intentionally don't call it
  });

  console.log('[BrowserView] Created with secure defaults');
  return view;
}

/**
 * Attach BrowserView to window and manage bounds.
 */
function attachBrowserView(window: BrowserWindow, view: BrowserView): void {
  window.setBrowserView(view);

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

  // Update bounds on resize
  window.on('resize', updateBounds);

  // Initial bounds
  updateBounds();

  // Auto-resize when ready
  view.setAutoResize({
    width: true,
    height: true,
    horizontal: false,
    vertical: false,
  });

  console.log('[BrowserView] Attached to window with custom title bar offset');
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
  window.loadFile(titleBarPath).catch((error) => {
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
    const { getMinimizeToTray } = require('./ipc-handlers');
    const shouldMinimizeToTray = getMinimizeToTray();

    if (shouldMinimizeToTray && !(app as any).isQuitting) {
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

  // Configure session
  const messengerSession = configureSession();

  // Create main window
  mainWindow = createMainWindow();

  // Register IPC handlers
  registerIpcHandlers(mainWindow);

  // Initialize tray
  initializeTray(mainWindow);

  // Create and attach BrowserView
  messengerView = createMessengerView(messengerSession);
  attachBrowserView(mainWindow, messengerView);

  // Create application menu
  createApplicationMenu(mainWindow);
  setMessengerView(messengerView);

  // Set up zoom functions for IPC handlers
  setZoomFunctions(zoomIn, zoomOut, zoomReset);

  // Set up theme change callback
  setThemeChangeCallback(handleThemeChange);

  // Check if this is first-time launch
  const hasLoggedIn = store.get('hasLoggedIn');

  if (!hasLoggedIn) {
    // First-time launch: go to Facebook login
    console.log('[App] First-time launch detected, loading Facebook login');
    await messengerView.webContents.loadURL(FACEBOOK_LOGIN_URL);
  } else {
    // User has logged in before: go directly to Messenger
    console.log(`[App] Loading ${MESSENGER_URL}`);
    await messengerView.webContents.loadURL(MESSENGER_URL);
  }

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
  app.whenReady().then(initializeApp).catch((error) => {
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

  // Disable new window creation except through our handler
  contents.setWindowOpenHandler(({ url }) => {
    // Only allow specific URLs to open in new windows
    shell.openExternal(url);
    return { action: 'deny' };
  });
});


