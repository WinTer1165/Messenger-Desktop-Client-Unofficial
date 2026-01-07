/**
 * Login Window Preload Script
 */

import { contextBridge, ipcRenderer } from 'electron';

// Expose login APIs
contextBridge.exposeInMainWorld('electronAPI', {
  // Start browser login
  startBrowserLogin: () => {
    console.log('[LoginPreload] Starting browser login');
    ipcRenderer.send('start-browser-login');
  },

  // Listen for login status updates
  onLoginStatus: (callback: (data: { status: string; message?: string }) => void) => {
    ipcRenderer.on('login-status', (_event, data) => {
      callback(data);
    });
  },
});

console.log('[LoginPreload] APIs exposed successfully');
