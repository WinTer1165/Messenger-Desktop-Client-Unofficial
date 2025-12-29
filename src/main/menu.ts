/**
 * Application Menu
 *
 * Custom menu with minimal items:
 * - Zoom controls (Zoom In, Zoom Out, Reset Zoom)
 * - About dialog
 */

import { app, Menu, dialog, BrowserWindow, BrowserView } from 'electron';

let messengerView: BrowserView | null = null;
let mainWindow: BrowserWindow | null = null;
let currentZoomLevel = 0;

/**
 * Set the BrowserView reference for zoom controls
 */
export function setMessengerView(view: BrowserView): void {
  messengerView = view;
}

/**
 * Show About dialog
 */
function showAboutDialog(window: BrowserWindow): void {
  dialog.showMessageBox(window, {
    type: 'info',
    title: 'About Messenger Desktop (Unofficial)',
    message: 'Messenger Desktop (Unofficial)',
    detail: `Version: ${app.getVersion()}
Electron: ${process.versions.electron}
Chrome: ${process.versions.chrome}
Node: ${process.versions.node}

A secure desktop client for Facebook Messenger with native OS integration.

© 2025`,
    buttons: ['OK'],
    icon: undefined,
  });
}

/**
 * Notify title bar of zoom level change
 */
function notifyZoomLevelChange(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('zoom-level-changed', currentZoomLevel);
  }
}

/**
 * Zoom In
 */
export function zoomIn(): void {
  if (!messengerView) return;

  currentZoomLevel += 0.5;
  if (currentZoomLevel > 3) currentZoomLevel = 3; // Max 300%

  messengerView.webContents.setZoomLevel(currentZoomLevel);
  notifyZoomLevelChange();
  console.log(`[Menu] Zoom level: ${currentZoomLevel} (${Math.round(100 + currentZoomLevel * 50)}%)`);
}

/**
 * Zoom Out
 */
export function zoomOut(): void {
  if (!messengerView) return;

  currentZoomLevel -= 0.5;
  if (currentZoomLevel < -3) currentZoomLevel = -3; // Min 25%

  messengerView.webContents.setZoomLevel(currentZoomLevel);
  notifyZoomLevelChange();
  console.log(`[Menu] Zoom level: ${currentZoomLevel} (${Math.round(100 + currentZoomLevel * 50)}%)`);
}

/**
 * Reset Zoom
 */
export function zoomReset(): void {
  if (!messengerView) return;

  currentZoomLevel = 0;
  messengerView.webContents.setZoomLevel(0);
  notifyZoomLevelChange();
  console.log('[Menu] Zoom reset to 100%');
}

/**
 * Setup keyboard shortcuts for zoom and other features
 */
export function setupKeyboardShortcuts(_window: BrowserWindow): void {
  // Zoom shortcuts are handled via local shortcuts in the menu
  // We'll use a minimal context menu instead

  console.log('[Menu] Keyboard shortcuts setup');
}

/**
 * Create a minimal context menu for right-click
 */
export function createContextMenu(window: BrowserWindow): Menu {
  const contextMenuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Zoom In',
      accelerator: 'CmdOrCtrl+=',
      click: zoomIn
    },
    {
      label: 'Zoom Out',
      accelerator: 'CmdOrCtrl+-',
      click: zoomOut
    },
    {
      label: 'Reset Zoom',
      accelerator: 'CmdOrCtrl+0',
      click: zoomReset
    },
    { type: 'separator' as const },
    {
      label: 'Reload',
      accelerator: 'CmdOrCtrl+R',
      click: () => {
        if (messengerView) {
          messengerView.webContents.reload();
        }
      }
    },
    { type: 'separator' as const },
    {
      label: 'About Messenger Desktop (Unofficial)',
      click: () => showAboutDialog(window)
    },
    { type: 'separator' as const },
    {
      label: 'Quit',
      accelerator: 'CmdOrCtrl+Q',
      click: () => app.quit()
    }
  ];

  return Menu.buildFromTemplate(contextMenuTemplate);
}

/**
 * Create and set the application menu (minimal version)
 */
export function createApplicationMenu(window: BrowserWindow): void {
  mainWindow = window;
  const isMac = process.platform === 'darwin';

  // On macOS, we need at least a basic menu for shortcuts to work
  // On Windows/Linux, we can remove it entirely
  if (isMac) {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          {
            label: 'About Messenger Desktop (Unofficial)',
            click: () => showAboutDialog(window)
          },
          { type: 'separator' as const },
          {
            label: 'Zoom In',
            accelerator: 'CmdOrCtrl+=',
            click: zoomIn
          },
          {
            label: 'Zoom Out',
            accelerator: 'CmdOrCtrl+-',
            click: zoomOut
          },
          {
            label: 'Reset Zoom',
            accelerator: 'CmdOrCtrl+0',
            click: zoomReset
          },
          { type: 'separator' as const },
          { role: 'quit' as const }
        ]
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  } else {
    // Remove menu bar on Windows/Linux for clean UI
    Menu.setApplicationMenu(null);
  }

  // Setup local keyboard shortcuts
  window.webContents.on('before-input-event', (event, input) => {
    const ctrl = input.control || input.meta;

    if (ctrl && input.type === 'keyDown') {
      if (input.key === '=' || input.key === '+') {
        event.preventDefault();
        zoomIn();
      } else if (input.key === '-' || input.key === '_') {
        event.preventDefault();
        zoomOut();
      } else if (input.key === '0') {
        event.preventDefault();
        zoomReset();
      }
    }
  });

  console.log('[Menu] Minimal menu created with keyboard shortcuts');
}

/**
 * Remove the application menu entirely (for minimal UI)
 */
export function removeApplicationMenu(): void {
  Menu.setApplicationMenu(null);
  console.log('[Menu] Application menu removed');
}
