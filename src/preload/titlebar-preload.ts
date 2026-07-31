/**
 * Title Bar Preload Script
 *
 * Exposes window control and zoom APIs to the title bar
 */

import { contextBridge, ipcRenderer } from 'electron';

// Expose APIs for title bar controls
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => {
    console.log('[TitleBarPreload] Sending window:minimize');
    ipcRenderer.send('window:minimize');
  },

  maximizeWindow: () => {
    console.log('[TitleBarPreload] Sending window:maximize');
    ipcRenderer.send('window:maximize');
  },

  closeWindow: () => {
    console.log('[TitleBarPreload] Sending window:close');
    ipcRenderer.send('window:close');
  },

  // Zoom controls
  zoomIn: () => {
    console.log('[TitleBarPreload] Sending zoom-in');
    ipcRenderer.send('zoom-in');
  },

  zoomOut: () => {
    console.log('[TitleBarPreload] Sending zoom-out');
    ipcRenderer.send('zoom-out');
  },

  zoomReset: () => {
    console.log('[TitleBarPreload] Sending zoom-reset');
    ipcRenderer.send('zoom-reset');
  },

  // Zoom level change listener
  onZoomLevelChange: (callback: (level: number) => void) => {
    console.log('[TitleBarPreload] Registering zoom level change listener');
    ipcRenderer.on('zoom-level-changed', (_event, level: number) => {
      console.log('[TitleBarPreload] Zoom level changed:', level);
      callback(level);
    });
  },

  // Theme change
  changeTheme: (theme: string) => {
    console.log('[TitleBarPreload] Sending theme:change', theme);
    ipcRenderer.send('theme:change', { theme });
  },

  // Open external URL
  openExternal: (url: string) => {
    console.log('[TitleBarPreload] Sending open-external', url);
    ipcRenderer.send('open-external', url);
  },

  // Minimize to tray setting
  setMinimizeToTray: (enabled: boolean) => {
    console.log('[TitleBarPreload] Sending minimize-to-tray setting:', enabled);
    ipcRenderer.send('minimize-to-tray', enabled);
  },

  // Go to home (messenger.com)
  goToHome: () => {
    console.log('[TitleBarPreload] Sending go-to-home');
    ipcRenderer.send('go-to-home');
  },

  // Check for updates
  checkForUpdates: () => {
    console.log('[TitleBarPreload] Sending check-for-updates');
    ipcRenderer.send('check-for-updates');
  },

  // Do Not Disturb
  setDoNotDisturb: (enabled: boolean) => {
    console.log('[TitleBarPreload] Sending set-do-not-disturb:', enabled);
    ipcRenderer.send('set-do-not-disturb', enabled);
  },

  getDoNotDisturb: (): Promise<boolean> =>
    ipcRenderer.invoke('get-do-not-disturb') as Promise<boolean>,

  // Fires when Do Not Disturb is toggled from the tray or the shortcut
  onDoNotDisturbChange: (callback: (enabled: boolean) => void) => {
    ipcRenderer.on('do-not-disturb-changed', (_event, enabled: boolean) => {
      console.log('[TitleBarPreload] Do Not Disturb changed:', enabled);
      callback(enabled);
    });
  },
});

console.log('[TitleBarPreload] APIs exposed successfully');
