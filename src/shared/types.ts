/**
 * Shared TypeScript types for the Messenger Wrapper application.
 * 
 * These types define the contract between:
 */

// ═══════════════════════════════════════════════════════════════════
// IPC CHANNEL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Channels for messages FROM preload TO main process.
 * These are the ONLY channels the preload script can send on.
 */
export const IPC_CHANNELS = {
  // Unread count updates from Messenger DOM observation
  UNREAD_COUNT_UPDATE: 'messenger:unread-count',

  // Window control requests (if using frameless window)
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // Notification permission request
  NOTIFICATION_REQUEST: 'notification:request',

  // App ready signal from preload
  APP_READY: 'app:ready',

  // Error reporting from preload
  ERROR_REPORT: 'error:report',
} as const;

/**
 * Channels for messages FROM main TO preload/renderer.
 * Used for main process to communicate state changes.
 */
export const IPC_MAIN_CHANNELS = {
  // Window focus state changes
  WINDOW_FOCUS_CHANGED: 'window:focus-changed',
  
  // Theme changes (if supporting system theme)
  THEME_CHANGED: 'theme:changed',
  
  // Network status changes
  NETWORK_STATUS: 'network:status',
} as const;

// Type-safe channel names
export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
export type IpcMainChannel = typeof IPC_MAIN_CHANNELS[keyof typeof IPC_MAIN_CHANNELS];

// ═══════════════════════════════════════════════════════════════════
// IPC PAYLOAD TYPES
// ═══════════════════════════════════════════════════════════════════

/**
 * Payload for unread count updates.
 * Contains the count and metadata for debouncing/deduplication.
 */
export interface UnreadCountPayload {
  /** Number of unread messages (0 = no unread) */
  count: number;
  /** Timestamp of detection (for ordering/deduplication) */
  timestamp: number;
  /** Detection method used (for debugging/metrics) */
  source: 'title' | 'dom' | 'favicon';
}

/**
 * Payload for error reports from preload.
 * Allows main process to log/handle errors from sandboxed context.
 */
export interface ErrorReportPayload {
  /** Error message */
  message: string;
  /** Error stack trace (if available) */
  stack?: string;
  /** Context where error occurred */
  context: 'dom-observer' | 'title-observer' | 'ipc' | 'unknown';
  /** Timestamp of error */
  timestamp: number;
}

/**
 * Payload for window focus changes.
 * Sent from main to preload when window gains/loses focus.
 */
export interface WindowFocusPayload {
  /** Whether window is currently focused */
  focused: boolean;
}

/**
 * Theme setting chosen by the user.
 * 'auto' follows the OS light/dark preference.
 */
export type ThemeSetting =
  | 'auto'
  | 'dark'
  | 'light'
  | 'lush-forest'
  | 'contrast'
  | 'desert'
  | 'electric'
  | 'northern-lights'
  | 'sakura-bloom'
  | 'deep-ocean'
  | 'cosmic-nebula'
  | 'sunset-drive'
  | 'arctic-frost'
  | 'neon-city';

/** All valid theme settings (used for IPC validation). */
export const VALID_THEMES: readonly ThemeSetting[] = [
  'auto',
  'dark',
  'light',
  'lush-forest',
  'contrast',
  'desert',
  'electric',
  'northern-lights',
  'sakura-bloom',
  'deep-ocean',
  'cosmic-nebula',
  'sunset-drive',
  'arctic-frost',
  'neon-city',
] as const;

/**
 * When the app lock asks for the PIN.
 * off    - never
 * launch - when the app starts
 * open   - when the app starts, and whenever the window comes back
 *          from the tray or the taskbar
 * away   - when the app starts, and after the window has gone
 *          unused for `awayMinutes`
 * 'open' and 'away' also lock when the computer locks or goes to sleep.
 */
export type AppLockMode = 'off' | 'launch' | 'open' | 'away';

/** All valid lock modes (used for IPC validation). */
export const VALID_LOCK_MODES: readonly AppLockMode[] = ['off', 'launch', 'open', 'away'] as const;

/** Choices for "lock after I've been away for". */
export const LOCK_AWAY_MINUTES: readonly number[] = [1, 5, 15, 30, 60] as const;

/**
 * Everything the settings page shows. The main process owns it; the
 * title bar document reads it and asks for changes.
 */
export interface AppSettings {
  theme: ThemeSetting;
  doNotDisturb: boolean;
  /** Keep message notifications up for 8 seconds */
  keepNotificationsOnScreen: boolean;
  /** Show "New message" instead of the text */
  hideMessagePreviews: boolean;
  /** No message notifications while a call window is open */
  pauseNotificationsDuringCalls: boolean;
  minimizeToTray: boolean;
  startWithSystem: boolean;
  appLock: {
    mode: AppLockMode;
    awayMinutes: number;
    hasPin: boolean;
  };
}

/** Settings the settings page may change directly (validated in main). */
export type BooleanSettingKey =
  | 'doNotDisturb'
  | 'keepNotificationsOnScreen'
  | 'hideMessagePreviews'
  | 'pauseNotificationsDuringCalls'
  | 'minimizeToTray'
  | 'startWithSystem';

/** Outcome of an app lock request (unlock, PIN change, mode change). */
export interface LockResult {
  ok: boolean;
  /** Why it failed: 'wrong-pin', 'invalid-pin', 'no-pin', 'locked' */
  error?: string;
  /** Too many wrong PINs: wait this long before trying again */
  retryAfterMs?: number;
}

/** A themed message box, drawn by the title bar document. */
export interface AppDialogOptions {
  /** Picks the icon and its colour */
  type: 'info' | 'success' | 'warning' | 'error' | 'question' | 'update';
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  /** Button for Enter (drawn as the main button) */
  defaultId?: number;
  /** Button for Esc and clicks outside */
  cancelId?: number;
  /** Button drawn in red, for something that can't be undone */
  dangerId?: number;
}

/**
 * Short version for display: trailing .0 parts dropped, so
 * 3.0.0 -> 3, 3.1.0 -> 3.1, 3.1.2 -> 3.1.2.
 */
export function toDisplayVersion(version: string): string {
  return version.replace(/(\.0)+$/, '');
}

/** App and runtime versions for the title bar and the About section. */
export interface AppInfo {
  /** Full version, e.g. 3.0.0 */
  version: string;
  /** Short version with trailing .0 parts dropped, e.g. 3 */
  displayVersion: string;
  electron: string;
  chrome: string;
  platform: 'win32' | 'darwin' | 'linux';
}

/**
 * A notification Messenger's page asked for, relayed to the main
 * process to be shown natively.
 */
export interface NotificationRequest {
  /** The page script's id for it, used to relay events back */
  id: number;
  title: string;
  body: string;
  /** Avatar URL (https or data:image) - may be empty */
  icon: string;
  /** A newer notification with the same tag replaces this one */
  tag: string;
  silent: boolean;
}

/**
 * Payload for theme changes.
 */
export interface ThemePayload {
  /** Current theme */
  theme: ThemeSetting;
}

/**
 * Payload for network status.
 */
export interface NetworkStatusPayload {
  /** Whether app is online */
  online: boolean;
}

/**
 * Whether Messenger could be reached, sent to the title bar so it can
 * show or hide the offline screen.
 */
export interface ConnectionStatus {
  /**
   * online     - Messenger is loaded (offline screen hidden)
   * offline    - the last load failed; retrying automatically
   * connecting - a retry is in flight
   */
  state: 'online' | 'offline' | 'connecting';
  /** Whether the OS reports any network connection at all */
  networkAvailable: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// WINDOW STATE TYPES
// ═══════════════════════════════════════════════════════════════════

/**
 * Persisted window state for restoring window position/size.
 */
export interface WindowState {
  /** Window x position */
  x?: number;
  /** Window y position */
  y?: number;
  /** Window width */
  width: number;
  /** Window height */
  height: number;
  /** Whether window is maximized */
  isMaximized: boolean;
  /** Whether window is fullscreen */
  isFullScreen: boolean;
}

/**
 * Default window state values.
 */
export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1200,
  height: 800,
  isMaximized: false,
  isFullScreen: false,
};

// ═══════════════════════════════════════════════════════════════════
// TRAY STATE TYPES
// ═══════════════════════════════════════════════════════════════════

/**
 * Tray icon state for badge/overlay rendering.
 */
export interface TrayState {
  /** Current unread count */
  unreadCount: number;
  /** Last update timestamp (for debouncing) */
  lastUpdate: number;
}

// ═══════════════════════════════════════════════════════════════════
// API EXPOSED TO BROWSERVIEW (via contextBridge)
// ═══════════════════════════════════════════════════════════════════
export interface MessengerBridgeAPI {
  /**
   * Send unread count to main process.
   * Fire-and-forget, no return value to prevent timing attacks.
   */
  sendUnreadCount: (count: number) => void;
  
  /**
   * Report an error to main process for logging.
   * Fire-and-forget, no return value.
   */
  reportError: (message: string, context: ErrorReportPayload['context']) => void;
  
  /**
   * Register callback for window focus changes.
   * Returns cleanup function to unregister.
   */
  onFocusChange: (callback: (focused: boolean) => void) => () => void;

  /**
   * Request the main window to be shown and focused.
   * Fire-and-forget, rate-limited in the main process.
   * Used by the notification click handler.
   */
  focusWindow: () => void;

  /**
   * Show a notification natively (see main/notifications.ts). Events
   * come back through window.__mdwNotificationEvent(id, type).
   * Fire-and-forget, rate-limited in the main process.
   */
  showNotification: (request: NotificationRequest) => void;

  /**
   * Close a notification shown with showNotification.
   * Fire-and-forget, rate-limited in the main process.
   */
  closeNotification: (id: number) => void;

  /**
   * Get current platform for platform-specific behavior.
   * Returns sanitized platform string (no version info).
   */
  readonly platform: 'win32' | 'darwin' | 'linux';
}

// ═══════════════════════════════════════════════════════════════════
// TYPE GUARDS AND VALIDATORS
// ═══════════════════════════════════════════════════════════════════

/**
 * Validate unread count is a safe integer.
 * Used in main process IPC handler.
 */
export function isValidUnreadCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 9999 // Reasonable upper bound
  );
}

/**
 * Validate UnreadCountPayload structure.
 */
export function isValidUnreadCountPayload(value: unknown): value is UnreadCountPayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    isValidUnreadCount(obj.count) &&
    typeof obj.timestamp === 'number' &&
    obj.timestamp > 0 &&
    (obj.source === 'title' || obj.source === 'dom' || obj.source === 'favicon')
  );
}

/**
 * Validate ErrorReportPayload structure.
 */
export function isValidErrorReportPayload(value: unknown): value is ErrorReportPayload {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.message === 'string' &&
    obj.message.length > 0 &&
    obj.message.length <= 10000 && // Prevent DoS via huge messages
    (obj.stack === undefined || typeof obj.stack === 'string') &&
    ['dom-observer', 'title-observer', 'ipc', 'unknown'].includes(obj.context as string) &&
    typeof obj.timestamp === 'number'
  );
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

/** Messenger URL - the only allowed URL for the messenger view */
export const MESSENGER_URL = 'https://www.messenger.com';

/** Session partition for persistent login */
export const SESSION_PARTITION = 'persist:messenger';

/** Debounce delay for tray updates (ms) */
export const TRAY_UPDATE_DEBOUNCE_MS = 500;

/** Debounce delay for window state save (ms) */
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 1000;
