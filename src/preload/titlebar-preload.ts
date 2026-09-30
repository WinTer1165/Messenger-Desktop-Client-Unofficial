/**
 * Title Bar Preload Script
 *
 * Exposes window, zoom, settings and app lock APIs to the title bar
 * document - which also hosts the settings page, the lock screen and
 * the offline screen shown in place of Messenger.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppDialogOptions,
  AppInfo,
  AppLockMode,
  AppSettings,
  ConnectionStatus,
  LockResult,
} from '../shared/types';

/** An app dialog as sent to the document: its id and Messenger's capture. */
type AppDialogRequest = AppDialogOptions & { id: number; backdrop: string };

/**
 * Subscribe to a main-process message for the page's lifetime.
 * `never` accepts a callback of any value type; each caller below
 * states the type the main process sends on its channel.
 */
function listen(channel: string, callback: (value: never) => void): void {
  ipcRenderer.on(channel, (_event, value: unknown) => callback(value as never));
}

// Expose APIs for title bar controls
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  getWindowMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke('get-window-maximized') as Promise<boolean>,
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) =>
    listen('window-maximized-changed', callback),

  // Zoom controls
  zoomIn: () => ipcRenderer.send('zoom-in'),
  zoomOut: () => ipcRenderer.send('zoom-out'),
  zoomReset: () => ipcRenderer.send('zoom-reset'),
  onZoomLevelChange: (callback: (level: number) => void) =>
    listen('zoom-level-changed', callback),

  // Navigation
  goToHome: () => ipcRenderer.send('go-to-home'),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),

  // Settings page
  getAppInfo: (): Promise<AppInfo> =>
    ipcRenderer.invoke('get-app-info') as Promise<AppInfo>,
  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('get-settings') as Promise<AppSettings>,
  onSettingsChange: (callback: (settings: AppSettings) => void) =>
    listen('settings-changed', callback),
  updateSetting: (key: string, value: unknown) =>
    ipcRenderer.send('update-setting', key, value),
  setSettingsOpen: (open: boolean) => ipcRenderer.send('settings-page', open),
  // Tray menu "Settings…" and Ctrl+,
  onOpenSettings: (callback: () => void) => listen('open-settings', callback),

  // App lock
  getLockState: (): Promise<boolean> =>
    ipcRenderer.invoke('get-lock-state') as Promise<boolean>,
  onLockStateChange: (callback: (locked: boolean) => void) =>
    listen('lock-state-changed', callback),
  unlock: (pin: string): Promise<LockResult> =>
    ipcRenderer.invoke('app-lock-unlock', pin) as Promise<LockResult>,
  changePin: (currentPin: string, newPin: string): Promise<LockResult> =>
    ipcRenderer.invoke('app-lock-change-pin', { currentPin, newPin }) as Promise<LockResult>,
  setLockMode: (mode: AppLockMode, pin: string): Promise<LockResult> =>
    ipcRenderer.invoke('app-lock-set-mode', { mode, pin }) as Promise<LockResult>,
  lockNow: () => ipcRenderer.send('app-lock-lock-now'),
  forgotPin: (): Promise<boolean> =>
    ipcRenderer.invoke('app-lock-forgot-pin') as Promise<boolean>,

  // App dialogs (update results, "Forgot PIN?", About)
  onAppDialog: (callback: (dialog: AppDialogRequest) => void) =>
    listen('app-dialog', callback),
  appDialogReady: (id: number) => ipcRenderer.send('app-dialog-ready', id),
  respondToAppDialog: (id: number, response: number) =>
    ipcRenderer.send('app-dialog-response', id, response),

  // Offline screen
  retryConnection: () => ipcRenderer.send('connection-retry'),
  getConnectionStatus: (): Promise<ConnectionStatus> =>
    ipcRenderer.invoke('get-connection-status') as Promise<ConnectionStatus>,
  onConnectionStatusChange: (callback: (status: ConnectionStatus) => void) =>
    listen('connection-status-changed', callback),
});

console.log('[TitleBarPreload] APIs exposed successfully');
