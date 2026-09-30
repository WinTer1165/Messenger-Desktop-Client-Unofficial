/**
 * Application Menu
 *
 * Custom menu with minimal items:
 * - Zoom controls (Zoom In, Zoom Out, Reset Zoom)
 * - About dialog
 */

import { app, Menu, BrowserWindow, WebContents, WebContentsView } from 'electron';
import * as dnd from './do-not-disturb';
import { showAppDialog } from './app-dialog';
import { toDisplayVersion } from '../shared/types';

let messengerView: WebContentsView | null = null;
let mainWindow: BrowserWindow | null = null;
let currentZoomLevel = 0;

// Opens the settings page (set by main)
let openSettingsHandler: (() => void) | null = null;

/**
 * Set what Ctrl/Cmd+, does (open the settings page)
 */
export function setOpenSettingsHandler(handler: () => void): void {
  openSettingsHandler = handler;
}

/**
 * Set the messenger view reference for zoom controls
 */
export function setMessengerView(view: WebContentsView): void {
  messengerView = view;
}

/**
 * Show About dialog
 */
function showAboutDialog(): void {
  void showAppDialog({
    type: 'info',
    title: 'About Messenger Desktop',
    message: `Messenger Desktop v${toDisplayVersion(app.getVersion())} - an unofficial desktop app for Facebook Messenger.`,
    detail: `Version ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome.split('.')[0]}. Not affiliated with or endorsed by Meta.`,
    buttons: ['OK'],
    defaultId: 0,
    cancelId: 0,
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
 * Reload the Messenger view.
 */
export function reloadMessenger(ignoreCache = false): void {
  if (!messengerView || messengerView.webContents.isDestroyed()) return;

  if (ignoreCache) {
    messengerView.webContents.reloadIgnoringCache();
  } else {
    messengerView.webContents.reload();
  }
  console.log(`[Menu] Reloaded Messenger${ignoreCache ? ' (ignoring cache)' : ''}`);
}

/**
 * Wire the app's keyboard shortcuts onto a webContents.
 *
 * WHY EVERY SURFACE NEEDS ITS OWN REGISTRATION:
 * The title bar and the Messenger view are separate webContents, and a
 * key event only reaches the one that currently has focus. Registering
 * on the window alone is why these shortcuts used to work in the title
 * bar and nowhere else - clicking into the Messenger UI moved focus to
 * the view, whose webContents had no handler.
 *
 * There is no application menu on Windows/Linux, so this is also the
 * only thing that makes the accelerators in our context menu real.
 */
export function registerShortcuts(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const mod = input.control || input.meta;

    // Reload works with or without a modifier
    if (input.key === 'F5' || (mod && input.key.toLowerCase() === 'r')) {
      event.preventDefault();
      reloadMessenger(input.shift);
      return;
    }

    if (!mod) return;

    switch (input.key.toLowerCase()) {
      case '=':
      case '+':
        event.preventDefault();
        zoomIn();
        break;

      case '-':
      case '_':
        event.preventDefault();
        zoomOut();
        break;

      case '0':
        event.preventDefault();
        zoomReset();
        break;

      case 'd':
        // Ctrl/Cmd+Shift+D only - plain Ctrl+D is a browser habit we
        // shouldn't steal from the page
        if (input.shift) {
          event.preventDefault();
          dnd.toggle();
        }
        break;

      case ',':
        event.preventDefault();
        openSettingsHandler?.();
        break;

      case 'q':
        event.preventDefault();
        app.quit();
        break;
    }
  });

  console.log('[Menu] Keyboard shortcuts registered for webContents', contents.id);
}

/**
 * Create a minimal context menu for right-click
 */
export function createContextMenu(): Menu {
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
      click: () => showAboutDialog()
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
            click: () => showAboutDialog()
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
          {
            label: 'Reload',
            accelerator: 'CmdOrCtrl+R',
            click: () => reloadMessenger()
          },
          {
            label: 'Do Not Disturb',
            accelerator: 'CmdOrCtrl+Shift+D',
            click: () => dnd.toggle()
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

  // Shortcuts are registered per webContents by the caller (see
  // registerShortcuts) - the window's own webContents only hosts the
  // title bar, so registering here alone would miss the Messenger view

  console.log('[Menu] Minimal menu created');
}

/**
 * Remove the application menu entirely (for minimal UI)
 */
export function removeApplicationMenu(): void {
  Menu.setApplicationMenu(null);
  console.log('[Menu] Application menu removed');
}
