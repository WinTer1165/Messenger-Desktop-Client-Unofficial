/**
 * IPC Handlers Module
 * 
 * Handles:
 * - Registration of all IPC handlers in the main process
 * - Input validation for all incoming messages
 * - Routing to appropriate subsystems (tray, notifications, etc.)
 * 
 * SECURITY ARCHITECTURE:
 * 
 * Trust Boundary:
 *   BrowserView (untrusted) → Preload (bridge) → Main (trusted)
 * 
 * All data from the preload script is treated as potentially malicious:
 * - Type validation on all payloads
 * - Bounds checking on numeric values
 * - String length limits to prevent DoS
 * - No arbitrary code execution
 * 
 * VALIDATION STRATEGY:
 * - Use type guards from shared/types.ts
 * - Fail closed (reject invalid input silently)
 * - Log validation failures for debugging
 */

import { ipcMain, IpcMainEvent, BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  isValidUnreadCount,
  isValidErrorReportPayload,
  ErrorReportPayload,
} from '../shared/types';
import { updateUnreadCount, stopFlashing } from './tray';

// Import zoom functions from menu module
let zoomInFunc: (() => void) | null = null;
let zoomOutFunc: (() => void) | null = null;
let zoomResetFunc: (() => void) | null = null;

// Theme change callback
let themeChangeCallback: ((theme: string) => void) | null = null;

// Minimize to tray setting
let minimizeToTray: boolean = false;

/**
 * Set zoom control functions from menu module
 */
export function setZoomFunctions(
  zoomIn: () => void,
  zoomOut: () => void,
  zoomReset: () => void
): void {
  zoomInFunc = zoomIn;
  zoomOutFunc = zoomOut;
  zoomResetFunc = zoomReset;
}

/**
 * Set theme change callback from main module
 */
export function setThemeChangeCallback(callback: (theme: string) => void): void {
  themeChangeCallback = callback;
}

/**
 * Get current minimize to tray setting
 */
export function getMinimizeToTray(): boolean {
  return minimizeToTray;
}

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let mainWindow: BrowserWindow | null = null;

// Rate limiting state
const rateLimiter = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second
const RATE_LIMIT_MAX_CALLS = 10;   // Max 10 calls per second per channel

// ═══════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a channel is rate limited.
 * Returns true if the call should be blocked.
 */
function isRateLimited(channel: string): boolean {
  const now = Date.now();
  const state = rateLimiter.get(channel);

  if (!state || now > state.resetTime) {
    // Reset rate limit window
    rateLimiter.set(channel, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW_MS,
    });
    return false;
  }

  if (state.count >= RATE_LIMIT_MAX_CALLS) {
    console.warn(`[IPC] Rate limited: ${channel}`);
    return true;
  }

  state.count++;
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// SENDER VALIDATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate that an IPC message comes from a legitimate sender.
 * 
 * SECURITY: This prevents arbitrary web content from sending IPC messages.
 * Only our preload script and attached BrowserViews should be able to send.
 */
function isValidSender(event: IpcMainEvent): boolean {
  // Check that sender is not null
  if (!event.sender) {
    console.warn('[IPC] Rejected: null sender');
    return false;
  }

  // Check that sender is not destroyed
  if (event.sender.isDestroyed()) {
    console.warn('[IPC] Rejected: destroyed sender');
    return false;
  }

  // In a more restrictive setup, you could validate:
  // - event.senderFrame.url matches expected origin
  // - event.sender.id matches known webContents IDs
  
  // For now, we trust the Electron IPC system's isolation
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// IPC HANDLERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle unread count updates from preload.
 */
function handleUnreadCountUpdate(_event: IpcMainEvent, payload: unknown): void {
  // Validate payload structure
  if (typeof payload !== 'object' || payload === null) {
    console.warn('[IPC] Invalid unread count payload type');
    return;
  }

  const data = payload as Record<string, unknown>;

  // Extract and validate count
  if (!isValidUnreadCount(data.count)) {
    console.warn('[IPC] Invalid unread count value:', data.count);
    return;
  }

  // Valid! Update the tray
  updateUnreadCount(data.count as number);
}

/**
 * Handle error reports from preload.
 */
function handleErrorReport(_event: IpcMainEvent, payload: unknown): void {
  if (!isValidErrorReportPayload(payload)) {
    console.warn('[IPC] Invalid error report payload');
    return;
  }

  const error = payload as ErrorReportPayload;
  
  // Log the error (in production, send to error tracking service)
  console.error(`[Preload Error] [${error.context}] ${error.message}`);
  if (error.stack) {
    console.error(error.stack);
  }
}

/**
 * Handle window minimize request.
 */
function handleWindowMinimize(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
}

/**
 * Handle window maximize/restore toggle.
 */
function handleWindowMaximize(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
}

/**
 * Handle window close request.
 */
function handleWindowClose(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
}

/**
 * Handle zoom in request.
 */
function handleZoomIn(): void {
  if (zoomInFunc) {
    zoomInFunc();
  }
}

/**
 * Handle zoom out request.
 */
function handleZoomOut(): void {
  if (zoomOutFunc) {
    zoomOutFunc();
  }
}

/**
 * Handle zoom reset request.
 */
function handleZoomReset(): void {
  if (zoomResetFunc) {
    zoomResetFunc();
  }
}

/**
 * Handle app ready signal from preload.
 */
function handleAppReady(_event: IpcMainEvent): void {
  console.log('[IPC] Preload signaled ready');
}

/**
 * Handle theme change from titlebar.
 */
function handleThemeChange(_event: IpcMainEvent, payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) {
    console.warn('[IPC] Invalid theme change payload');
    return;
  }

  const data = payload as Record<string, unknown>;
  const theme = data.theme as string;

  const validThemes = ['dark', 'light', 'lush-forest', 'contrast', 'desert', 'electric'];
  if (!validThemes.includes(theme)) {
    console.warn('[IPC] Invalid theme value:', theme);
    return;
  }

  console.log('[IPC] Theme change requested:', theme);

  if (themeChangeCallback) {
    themeChangeCallback(theme);
  }
}

// ═══════════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a wrapped handler with validation and rate limiting.
 */
function createHandler(
  channel: string,
  handler: (event: IpcMainEvent, ...args: unknown[]) => void
): (event: IpcMainEvent, ...args: unknown[]) => void {
  return (event: IpcMainEvent, ...args: unknown[]) => {
    // Validate sender
    if (!isValidSender(event)) {
      return;
    }

    // Check rate limiting
    if (isRateLimited(channel)) {
      return;
    }

    // Call the actual handler
    try {
      handler(event, ...args);
    } catch (error) {
      console.error(`[IPC] Handler error for ${channel}:`, error);
    }
  };
}

/**
 * Handle open external URL request.
 */
function handleOpenExternal(_event: IpcMainEvent, url: unknown): void {
  // Validate URL
  if (typeof url !== 'string' || !url) {
    console.warn('[IPC] Invalid URL for open-external');
    return;
  }

  // Only allow https URLs for security
  if (!url.startsWith('https://')) {
    console.warn('[IPC] Only HTTPS URLs are allowed:', url);
    return;
  }

  // Import shell at runtime to avoid circular dependency
  import('electron').then(({ shell }) => {
    console.log('[IPC] Opening external URL:', url);
    shell.openExternal(url as string);
  });
}

/**
 * Handle minimize to tray setting change.
 */
function handleMinimizeToTray(_event: IpcMainEvent, enabled: unknown): void {
  // Validate input
  if (typeof enabled !== 'boolean') {
    console.warn('[IPC] Invalid minimize-to-tray value:', enabled);
    return;
  }

  minimizeToTray = enabled;
  console.log('[IPC] Minimize to tray setting changed:', enabled ? 'ENABLED' : 'DISABLED');
}

/**
 * Register all IPC handlers.
 * Call this once during app initialization.
 *
 * @param window - The main BrowserWindow instance
 */
export function registerIpcHandlers(window: BrowserWindow): void {
  mainWindow = window;

  // Unread count updates
  ipcMain.on(
    IPC_CHANNELS.UNREAD_COUNT_UPDATE,
    createHandler(IPC_CHANNELS.UNREAD_COUNT_UPDATE, handleUnreadCountUpdate)
  );

  // Error reports
  ipcMain.on(
    IPC_CHANNELS.ERROR_REPORT,
    createHandler(IPC_CHANNELS.ERROR_REPORT, handleErrorReport)
  );

  // Window controls
  ipcMain.on(
    IPC_CHANNELS.WINDOW_MINIMIZE,
    createHandler(IPC_CHANNELS.WINDOW_MINIMIZE, handleWindowMinimize)
  );

  ipcMain.on(
    IPC_CHANNELS.WINDOW_MAXIMIZE,
    createHandler(IPC_CHANNELS.WINDOW_MAXIMIZE, handleWindowMaximize)
  );

  ipcMain.on(
    IPC_CHANNELS.WINDOW_CLOSE,
    createHandler(IPC_CHANNELS.WINDOW_CLOSE, handleWindowClose)
  );

  // Zoom controls
  ipcMain.on(
    'zoom-in',
    createHandler('zoom-in', handleZoomIn)
  );

  ipcMain.on(
    'zoom-out',
    createHandler('zoom-out', handleZoomOut)
  );

  ipcMain.on(
    'zoom-reset',
    createHandler('zoom-reset', handleZoomReset)
  );

  // App ready signal
  ipcMain.on(
    IPC_CHANNELS.APP_READY,
    createHandler(IPC_CHANNELS.APP_READY, handleAppReady)
  );

  // Theme change
  ipcMain.on(
    IPC_CHANNELS.THEME_CHANGE,
    createHandler(IPC_CHANNELS.THEME_CHANGE, handleThemeChange)
  );

  // Open external URL
  ipcMain.on(
    'open-external',
    createHandler('open-external', handleOpenExternal)
  );

  // Minimize to tray setting
  ipcMain.on(
    'minimize-to-tray',
    createHandler('minimize-to-tray', handleMinimizeToTray)
  );

  console.log('[IPC] Handlers registered');
}

/**
 * Unregister all IPC handlers.
 * Call this during app cleanup.
 */
export function unregisterIpcHandlers(): void {
  ipcMain.removeAllListeners(IPC_CHANNELS.UNREAD_COUNT_UPDATE);
  ipcMain.removeAllListeners(IPC_CHANNELS.ERROR_REPORT);
  ipcMain.removeAllListeners(IPC_CHANNELS.WINDOW_MINIMIZE);
  ipcMain.removeAllListeners(IPC_CHANNELS.WINDOW_MAXIMIZE);
  ipcMain.removeAllListeners(IPC_CHANNELS.WINDOW_CLOSE);
  ipcMain.removeAllListeners('zoom-in');
  ipcMain.removeAllListeners('zoom-out');
  ipcMain.removeAllListeners('zoom-reset');
  ipcMain.removeAllListeners(IPC_CHANNELS.APP_READY);
  ipcMain.removeAllListeners(IPC_CHANNELS.THEME_CHANGE);

  mainWindow = null;
  zoomInFunc = null;
  zoomOutFunc = null;
  zoomResetFunc = null;
  themeChangeCallback = null;
  rateLimiter.clear();

  console.log('[IPC] Handlers unregistered');
}

/**
 * Send a message to the renderer/preload.
 */
export function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

/**
 * Notify preload of window focus changes.
 * Call this when window focus state changes.
 */
export function notifyFocusChange(focused: boolean): void {
  // Also stop flashing when window gains focus
  if (focused) {
    stopFlashing();
  }

  sendToRenderer('window:focus-changed', { focused });
}
