/**
 * Overlays
 *
 * Screens the title bar document shows in place of Messenger: the
 * offline screen, the settings page, the lock screen, and app dialogs
 * (over a capture of Messenger - see app-dialog.ts). The document
 * fills the whole window under the Messenger view, so while any of them
 * is up the view is simply hidden to uncover it.
 *
 * Each screen is switched on and off independently; the view comes
 * back only when none is left. Which one the document draws on top is
 * its own business (lock > settings > offline).
 */

import { BrowserWindow, WebContentsView } from 'electron';

export type Overlay = 'offline' | 'settings' | 'lock' | 'dialog';

let window: BrowserWindow | null = null;
let view: WebContentsView | null = null;
const active = new Set<Overlay>();

function apply(): void {
  if (!window || window.isDestroyed() || !view || view.webContents.isDestroyed()) return;

  const showMessenger = active.size === 0;
  if (view.getVisible() === showMessenger) return;

  view.setVisible(showMessenger);

  // Keys go to whichever surface is showing - the hidden view would
  // otherwise keep focus, and the lock screen's PIN field would get none
  if (window.isFocused()) {
    if (showMessenger) {
      view.webContents.focus();
    } else {
      window.webContents.focus();
    }
  }
}

/** Connect the window and the Messenger view the overlays cover. */
export function attachOverlays(mainWindow: BrowserWindow, messengerView: WebContentsView): void {
  window = mainWindow;
  view = messengerView;
  apply();
}

export function setOverlay(overlay: Overlay, on: boolean): void {
  if (on) {
    active.add(overlay);
  } else {
    active.delete(overlay);
  }
  apply();
}

export function isOverlayActive(overlay: Overlay): boolean {
  return active.has(overlay);
}
