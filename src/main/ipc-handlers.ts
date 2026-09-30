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
 * Settings and app lock requests are only accepted from the title bar
 * document (our own local page), never from messenger.com.
 *
 * VALIDATION STRATEGY:
 * - Use type guards from shared/types.ts
 * - Fail closed (reject invalid input silently)
 */

import {
  app,
  ipcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  BrowserWindow,
  shell,
} from 'electron';
import {
  IPC_CHANNELS,
  isValidUnreadCount,
  isValidErrorReportPayload,
  AppInfo,
  AppLockMode,
  BooleanSettingKey,
  LockResult,
  LOCK_AWAY_MINUTES,
  NotificationRequest,
  ThemeSetting,
  toDisplayVersion,
  VALID_LOCK_MODES,
  VALID_THEMES,
} from '../shared/types';
import { updateUnreadCount, stopFlashing } from './tray';
import * as settings from './settings';
import * as dnd from './do-not-disturb';
import * as connectivity from './connectivity';
import * as appLock from './app-lock';
import { setOverlay } from './overlays';
import { handleDialogReady, handleDialogResponse } from './app-dialog';
import { showNotification, closeNotification } from './notifications';
import { checkForUpdatesInteractive } from './updater';

// Import zoom functions from menu module
let zoomInFunc: (() => void) | null = null;
let zoomOutFunc: (() => void) | null = null;
let zoomResetFunc: (() => void) | null = null;

// Theme change callback
let themeChangeCallback: ((theme: ThemeSetting) => void) | null = null;

// Go to home callback
let goToHomeCallback: (() => void) | null = null;

// "Forgot PIN?" callback: signs out of Messenger (main owns the view)
let forgotPinCallback: (() => Promise<boolean>) | null = null;

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
export function setThemeChangeCallback(callback: (theme: ThemeSetting) => void): void {
  themeChangeCallback = callback;
}

/**
 * Set go to home callback from main module
 */
export function setGoToHomeCallback(callback: () => void): void {
  goToHomeCallback = callback;
}

/**
 * Set the "Forgot PIN?" callback from main module
 */
export function setForgotPinCallback(callback: () => Promise<boolean>): void {
  forgotPinCallback = callback;
}

/**
 * Get current minimize to tray setting
 */
export function getMinimizeToTray(): boolean {
  return settings.getMinimizeToTray();
}

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let mainWindow: BrowserWindow | null = null;

// Rate limiting state
const rateLimiter = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second
const RATE_LIMIT_MAX_CALLS = 10;   // Max 10 calls per second per channel

/** Longest notification text relayed from the page */
const MAX_NOTIFICATION_TEXT = 2000;

/** Longest avatar URL relayed from the page (data URLs included) */
const MAX_NOTIFICATION_ICON = 3 * 1024 * 1024;

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

/**
 * Whether a message comes from the title bar document - the only
 * sender allowed to change settings or talk to the app lock.
 */
function isFromShell(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const fromShell =
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents;

  if (!fromShell) {
    console.warn('[IPC] Rejected: settings/lock request from outside the title bar');
  }
  return fromShell;
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
  updateUnreadCount(data.count);
}

/**
 * Handle error reports from preload.
 */
function handleErrorReport(_event: IpcMainEvent, payload: unknown): void {
  if (!isValidErrorReportPayload(payload)) {
    console.warn('[IPC] Invalid error report payload');
    return;
  }

  const error = payload;

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

  console.log('[IPC] Opening external URL:', url);
  void shell.openExternal(url);
}

/**
 * Handle update check request from the titlebar.
 */
function handleCheckForUpdates(): void {
  console.log('[IPC] Update check requested from titlebar');
  checkForUpdatesInteractive();
}

/**
 * Handle focus window request (e.g. from a notification click).
 */
function handleFocusWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  }
}

/**
 * Handle go to home request.
 */
function handleGoToHome(): void {
  console.log('[IPC] Go to home requested');
  if (goToHomeCallback) {
    goToHomeCallback();
  }
}

/**
 * Handle the Retry button on the offline screen.
 */
function handleConnectionRetry(): void {
  console.log('[IPC] Connection retry requested');
  connectivity.retryNow();
}

// ─── Notifications relayed from Messenger's page ─────────────────

function isValidNotificationId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0 && id <= 1_000_000_000;
}

/**
 * Handle a notification Messenger asked for (see notifications.ts).
 */
function handleNotificationShow(event: IpcMainEvent, payload: unknown): void {
  if (typeof payload !== 'object' || payload === null) {
    console.warn('[IPC] Invalid notification payload');
    return;
  }

  const data = payload as Record<string, unknown>;
  const text = (value: unknown, max: number): string | null =>
    typeof value === 'string' ? value.slice(0, max) : null;

  const title = text(data.title, MAX_NOTIFICATION_TEXT);
  const body = text(data.body, MAX_NOTIFICATION_TEXT);
  const icon = text(data.icon, MAX_NOTIFICATION_ICON);
  const tag = text(data.tag, 500);

  if (
    !isValidNotificationId(data.id) ||
    title === null ||
    body === null ||
    icon === null ||
    tag === null ||
    typeof data.silent !== 'boolean'
  ) {
    console.warn('[IPC] Invalid notification payload');
    return;
  }

  const request: NotificationRequest = {
    id: data.id,
    title,
    body,
    icon,
    tag,
    silent: data.silent,
  };

  showNotification(event.sender, request).catch((error: unknown) => {
    console.error('[IPC] Failed to show notification:', error);
  });
}

/**
 * Handle Messenger closing one of its notifications.
 */
function handleNotificationClose(event: IpcMainEvent, id: unknown): void {
  if (!isValidNotificationId(id)) {
    console.warn('[IPC] Invalid notification id:', id);
    return;
  }

  closeNotification(event.sender, id);
}

// ─── Settings page ────────────────────────────────────────────────

const BOOLEAN_SETTINGS: Record<BooleanSettingKey, (value: boolean) => void> = {
  doNotDisturb: (value) => dnd.setEnabled(value),
  keepNotificationsOnScreen: (value) => settings.setKeepNotificationsOnScreen(value),
  hideMessagePreviews: (value) => settings.setHideMessagePreviews(value),
  pauseNotificationsDuringCalls: (value) => settings.setPauseNotificationsDuringCalls(value),
  minimizeToTray: (value) => settings.setMinimizeToTray(value),
  startWithSystem: (value) => settings.setStartWithSystem(value),
};

/**
 * Handle a change from the settings page (or the title bar's bell).
 */
function handleUpdateSetting(event: IpcMainEvent, key: unknown, value: unknown): void {
  if (!isFromShell(event) || appLock.isLocked()) return;

  if (key === 'theme') {
    if (typeof value !== 'string' || !VALID_THEMES.includes(value as ThemeSetting)) {
      console.warn('[IPC] Invalid theme value:', value);
      return;
    }
    themeChangeCallback?.(value as ThemeSetting);
    return;
  }

  if (key === 'lockAwayMinutes') {
    if (typeof value !== 'number' || !LOCK_AWAY_MINUTES.includes(value)) {
      console.warn('[IPC] Invalid lock away minutes:', value);
      return;
    }
    settings.setAppLockAwayMinutes(value);
    return;
  }

  if (typeof key === 'string' && key in BOOLEAN_SETTINGS && typeof value === 'boolean') {
    console.log(`[IPC] Setting ${key}: ${value}`);
    BOOLEAN_SETTINGS[key as BooleanSettingKey](value);
    return;
  }

  console.warn('[IPC] Invalid setting:', key, value);
}

/**
 * Handle the settings page opening or closing: Messenger is hidden
 * while it is up.
 */
function handleSettingsPage(event: IpcMainEvent, open: unknown): void {
  if (!isFromShell(event) || typeof open !== 'boolean') return;
  setOverlay('settings', open && !appLock.isLocked());
}

/** Versions shown in the title bar and the About section. */
function getAppInfo(): AppInfo {
  const version = app.getVersion();
  const platform = process.platform;

  return {
    version,
    displayVersion: toDisplayVersion(version),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: platform === 'win32' || platform === 'darwin' ? platform : 'linux',
  };
}

// ─── App lock ─────────────────────────────────────────────────────

const REJECTED: LockResult = { ok: false, error: 'rejected' };

function handleUnlock(event: IpcMainInvokeEvent, pin: unknown): LockResult {
  return isFromShell(event) ? appLock.unlock(pin) : REJECTED;
}

function handleChangePin(event: IpcMainInvokeEvent, payload: unknown): LockResult {
  if (!isFromShell(event) || typeof payload !== 'object' || payload === null) return REJECTED;

  const data = payload as Record<string, unknown>;
  return appLock.changePin(data.currentPin, data.newPin);
}

function handleSetLockMode(event: IpcMainInvokeEvent, payload: unknown): LockResult {
  if (!isFromShell(event) || typeof payload !== 'object' || payload === null) return REJECTED;

  const data = payload as Record<string, unknown>;
  if (typeof data.mode !== 'string' || !VALID_LOCK_MODES.includes(data.mode as AppLockMode)) {
    return REJECTED;
  }
  return appLock.setMode(data.mode as AppLockMode, data.pin);
}

function handleLockNow(event: IpcMainEvent): void {
  if (isFromShell(event)) {
    appLock.lock('lock now');
  }
}

/**
 * "Forgot PIN?": sign out of Messenger after asking (see main.ts).
 */
async function handleForgotPin(event: IpcMainInvokeEvent): Promise<boolean> {
  if (!isFromShell(event) || !forgotPinCallback) return false;
  return forgotPinCallback();
}

// ─── App dialogs ──────────────────────────────────────────────────

function isValidDialogId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

/**
 * The title bar document has drawn an app dialog (Messenger can hide).
 */
function handleAppDialogReady(event: IpcMainEvent, id: unknown): void {
  if (isFromShell(event) && isValidDialogId(id)) {
    handleDialogReady(id);
  }
}

/**
 * The user answered an app dialog.
 */
function handleAppDialogResponse(event: IpcMainEvent, id: unknown, response: unknown): void {
  if (
    isFromShell(event) &&
    isValidDialogId(id) &&
    typeof response === 'number' &&
    Number.isInteger(response) &&
    response >= 0
  ) {
    handleDialogResponse(id, response);
  }
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

  // Open external URL
  ipcMain.on(
    'open-external',
    createHandler('open-external', handleOpenExternal)
  );

  // Go to home
  ipcMain.on(
    'go-to-home',
    createHandler('go-to-home', handleGoToHome)
  );

  // Focus window (notification click-to-focus)
  ipcMain.on(
    'focus-window',
    createHandler('focus-window', handleFocusWindow)
  );

  // Notifications relayed from Messenger's page
  ipcMain.on(
    'notification-show',
    createHandler('notification-show', handleNotificationShow)
  );
  ipcMain.on(
    'notification-close',
    createHandler('notification-close', handleNotificationClose)
  );

  // Offline screen: Retry button and initial state
  ipcMain.on(
    'connection-retry',
    createHandler('connection-retry', handleConnectionRetry)
  );
  ipcMain.handle('get-connection-status', () => connectivity.getStatus());

  // Maximize/restore glyph in the title bar
  ipcMain.handle('get-window-maximized', () =>
    mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isMaximized()
  );

  // Update check from the settings page
  ipcMain.on(
    'check-for-updates',
    createHandler('check-for-updates', handleCheckForUpdates)
  );

  // Settings page
  ipcMain.handle('get-app-info', () => getAppInfo());
  ipcMain.handle('get-settings', () => settings.getSnapshot());
  ipcMain.on(
    'update-setting',
    createHandler('update-setting', handleUpdateSetting)
  );
  ipcMain.on(
    'settings-page',
    createHandler('settings-page', handleSettingsPage)
  );

  // App lock
  ipcMain.handle('get-lock-state', () => appLock.isLocked());
  ipcMain.handle('app-lock-unlock', handleUnlock);
  ipcMain.handle('app-lock-change-pin', handleChangePin);
  ipcMain.handle('app-lock-set-mode', handleSetLockMode);
  ipcMain.handle('app-lock-forgot-pin', handleForgotPin);
  ipcMain.on(
    'app-lock-lock-now',
    createHandler('app-lock-lock-now', handleLockNow)
  );

  // App dialogs drawn by the title bar document
  ipcMain.on(
    'app-dialog-ready',
    createHandler('app-dialog-ready', handleAppDialogReady)
  );
  ipcMain.on(
    'app-dialog-response',
    createHandler('app-dialog-response', handleAppDialogResponse)
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
  ipcMain.removeAllListeners('open-external');
  ipcMain.removeAllListeners('go-to-home');
  ipcMain.removeAllListeners('focus-window');
  ipcMain.removeAllListeners('notification-show');
  ipcMain.removeAllListeners('notification-close');
  ipcMain.removeAllListeners('connection-retry');
  ipcMain.removeHandler('get-connection-status');
  ipcMain.removeHandler('get-window-maximized');
  ipcMain.removeAllListeners('check-for-updates');
  ipcMain.removeHandler('get-app-info');
  ipcMain.removeHandler('get-settings');
  ipcMain.removeAllListeners('update-setting');
  ipcMain.removeAllListeners('settings-page');
  ipcMain.removeHandler('get-lock-state');
  ipcMain.removeHandler('app-lock-unlock');
  ipcMain.removeHandler('app-lock-change-pin');
  ipcMain.removeHandler('app-lock-set-mode');
  ipcMain.removeHandler('app-lock-forgot-pin');
  ipcMain.removeAllListeners('app-lock-lock-now');
  ipcMain.removeAllListeners('app-dialog-ready');
  ipcMain.removeAllListeners('app-dialog-response');

  mainWindow = null;
  zoomInFunc = null;
  zoomOutFunc = null;
  zoomResetFunc = null;
  themeChangeCallback = null;
  goToHomeCallback = null;
  forgotPinCallback = null;
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
