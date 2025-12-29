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
});

console.log('[TitleBarPreload] APIs exposed successfully');
