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

  // Theme change from titlebar
  THEME_CHANGE: 'theme:change',
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
 * Payload for theme changes.
 */
export interface ThemePayload {
  /** Current theme */
  theme: 'dark' | 'light' | 'lush-forest' | 'contrast' | 'desert' | 'electric';
}

/**
 * Payload for network status.
 */
export interface NetworkStatusPayload {
  /** Whether app is online */
  online: boolean;
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

/** Messenger URL - the only allowed URL for BrowserView */
export const MESSENGER_URL = 'https://www.messenger.com';

/** Session partition for persistent login */
export const SESSION_PARTITION = 'persist:messenger';

/** User agent override (optional, helps avoid bot detection) */
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Debounce delay for tray updates (ms) */
export const TRAY_UPDATE_DEBOUNCE_MS = 500;

/** Debounce delay for window state save (ms) */
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 1000;
