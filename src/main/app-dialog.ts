/**
 * App Dialogs
 *
 * Message boxes drawn by the title bar document in the app's theme,
 * instead of the OS's plain ones (update checks, "Forgot PIN?", About).
 *
 * The Messenger view is a separate surface on top of that document, so
 * a dialog can't simply float over it. Instead the view is captured,
 * the document shows the capture dimmed behind the dialog, and only
 * then is the view hidden (the 'dialog' overlay) - it looks like a modal
 * over Messenger. Once the dialog is answered, Messenger comes back.
 *
 * When the window can't show one (hidden to the tray, minimized), the
 * native dialog is used instead.
 */

import { BrowserWindow, dialog, WebContentsView } from 'electron';
import { AppDialogOptions } from '../shared/types';
import { isOverlayActive, setOverlay } from './overlays';

/** Wait this long for the document to draw the dialog before giving up. */
const READY_TIMEOUT_MS = 1500;

let window: BrowserWindow | null = null;
let view: WebContentsView | null = null;
let nextId = 0;

interface PendingDialog {
  resolve: (response: number) => void;
  ready: () => void;
}

const pending = new Map<number, PendingDialog>();

export function initializeAppDialogs(
  mainWindow: BrowserWindow,
  messengerView: WebContentsView
): void {
  window = mainWindow;
  view = messengerView;
}

/** The OS dialog, for when the window can't show ours. */
async function showNativeDialog(options: AppDialogOptions): Promise<number> {
  const messageBoxOptions: Electron.MessageBoxOptions = {
    type: options.type === 'success' || options.type === 'update' ? 'info' : options.type,
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: options.buttons,
    defaultId: options.defaultId,
    cancelId: options.cancelId,
  };

  const parent = window && !window.isDestroyed() ? window : null;
  const result = parent
    ? await dialog.showMessageBox(parent, messageBoxOptions)
    : await dialog.showMessageBox(messageBoxOptions);
  return result.response;
}

/**
 * A capture of Messenger to show dimmed behind the dialog - only while
 * Messenger is what's on screen (not the settings page, lock screen...).
 */
async function captureBackdrop(): Promise<string> {
  const messenger = view;
  const messengerShowing =
    messenger !== null &&
    !messenger.webContents.isDestroyed() &&
    messenger.getVisible() &&
    !isOverlayActive('dialog');
  if (!messengerShowing) return '';

  try {
    const image = await messenger.webContents.capturePage();
    return 'data:image/jpeg;base64,' + image.toJPEG(75).toString('base64');
  } catch (error) {
    console.warn('[AppDialog] Could not capture the backdrop:', error);
    return '';
  }
}

/**
 * Show a themed dialog. Resolves with the index of the button chosen
 * (the cancel button's for Esc or a click outside).
 */
export async function showAppDialog(options: AppDialogOptions): Promise<number> {
  const win = window;
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
    return showNativeDialog(options);
  }

  const id = ++nextId;
  const backdrop = await captureBackdrop();

  return new Promise<number>((resolve) => {
    // Messenger is hidden only once the document has drawn the dialog,
    // so nothing flashes in between
    const readyTimer = setTimeout(() => entry.ready(), READY_TIMEOUT_MS);

    const entry: PendingDialog = {
      ready: () => {
        clearTimeout(readyTimer);
        // Already answered: Messenger must stay visible
        if (pending.has(id)) {
          setOverlay('dialog', true);
        }
      },
      resolve: (response: number) => {
        clearTimeout(readyTimer);
        pending.delete(id);
        if (pending.size === 0) {
          setOverlay('dialog', false);
        }
        resolve(response);
      },
    };
    pending.set(id, entry);

    win.webContents.send('app-dialog', { ...options, id, backdrop });
  });
}

/** The document has drawn dialog `id`. */
export function handleDialogReady(id: number): void {
  pending.get(id)?.ready();
}

/** The user answered dialog `id`. */
export function handleDialogResponse(id: number, response: number): void {
  pending.get(id)?.resolve(response);
}
