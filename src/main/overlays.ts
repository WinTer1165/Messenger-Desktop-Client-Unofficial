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

/**
 * A view that takes Messenger's place on screen while `wanted` is true
 * (Marketplace). It is subject to the overlays like Messenger is.
 */
interface Surface {
  get: () => WebContentsView | null;
  wanted: () => boolean;
}
const surfaces: Surface[] = [];

function alive(candidate: WebContentsView | null): candidate is WebContentsView {
  return candidate !== null && !candidate.webContents.isDestroyed();
}

function apply(): void {
  if (!window || window.isDestroyed() || !alive(view)) return;

  // At most one surface is wanted at a time; Messenger is the fallback
  const cover = surfaces.find((surface) => surface.wanted() && alive(surface.get()));
  const clear = active.size === 0;
  const targets: [WebContentsView, boolean][] = [[view, clear && !cover]];
  for (const surface of surfaces) {
    const surfaceView = surface.get();
    if (alive(surfaceView)) targets.push([surfaceView, clear && surface === cover]);
  }

  let shown: WebContentsView | null = null;
  let changed = false;
  for (const [target, visible] of targets) {
    if (target.getVisible() !== visible) {
      target.setVisible(visible);
      changed = true;
      if (visible) shown = target;
    }
  }

  // Keys go to whichever surface is showing - a hidden view would
  // otherwise keep focus, and the lock screen's PIN field would get none
  if (changed && window.isFocused()) {
    if (shown) {
      shown.webContents.focus();
    } else if (!clear) {
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

/**
 * Register a view that replaces Messenger on screen while `wanted()`
 * is true. Call refreshOverlays() whenever either answer changes.
 */
export function registerOverlaySurface(
  get: () => WebContentsView | null,
  wanted: () => boolean
): void {
  surfaces.push({ get, wanted });
}

/** Re-evaluate which view is visible. */
export function refreshOverlays(): void {
  apply();
}

/** The view currently on screen, or null when an overlay covers it. */
export function getShowingView(): WebContentsView | null {
  const candidates = [view, ...surfaces.map((surface) => surface.get())];
  return candidates.find((candidate) => alive(candidate) && candidate.getVisible()) ?? null;
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
