/**
 * Facebook Marketplace
 *
 * Marketplace lives in a second WebContentsView next to Messenger's,
 * not in the Messenger view itself: navigating that one away would stop
 * its notifications and unread badge and lose the user's place in their
 * chats. While Marketplace shows, Messenger stays loaded and running,
 * only hidden (see overlays.ts, which also hides both views while the
 * settings page, lock screen, offline screen or a dialog is up).
 *
 * The view is created on first use, in the same session partition as
 * Messenger (one Facebook login), and is dropped again on sign-out.
 */

import { BrowserWindow, Session, WebContentsView } from 'electron';
import { isInAppUrl, openInBrowser, unwrapRedirectUrl } from './navigation';
import { refreshOverlays, registerOverlaySurface } from './overlays';

export const MARKETPLACE_URL = 'https://www.facebook.com/marketplace/';

/** Height of the custom title bar the view sits below. */
const TITLE_BAR_HEIGHT = 40;

interface MarketplaceOptions {
  window: BrowserWindow;
  session: Session;
  /** Wire up per-view behaviour that lives elsewhere (shortcuts, context menu, zoom). */
  onViewCreated: (view: WebContentsView) => void;
  /** Tell the title bar whether Marketplace is showing. */
  onStateChange: (showing: boolean) => void;
}

let options: MarketplaceOptions | null = null;
let view: WebContentsView | null = null;
let removeBoundsListeners: (() => void) | null = null;
let showing = false;

/** Whether a URL is Messenger's own site (not a link shim - callers unwrap first). */
function isMessengerUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'messenger.com' || host.endsWith('.messenger.com');
  } catch {
    return false;
  }
}

/** The Marketplace view, if it has been created. */
export function getMarketplaceView(): WebContentsView | null {
  return view && !view.webContents.isDestroyed() ? view : null;
}

/** Whether Marketplace is the view the user asked to see. */
export function isMarketplaceShowing(): boolean {
  return showing;
}

function setShowing(value: boolean): void {
  if (showing === value) return;
  showing = value;
  options?.onStateChange(value);
  refreshOverlays();
}

/**
 * Hook the overlays up. Must be called once the window and session
 * exist; creates no view yet.
 */
export function initializeMarketplace(opts: MarketplaceOptions): void {
  options = opts;
  registerOverlaySurface(getMarketplaceView, isMarketplaceShowing);
}

function createView(): WebContentsView | null {
  if (!options || options.window.isDestroyed()) return null;
  const { window, session } = options;

  const created = new WebContentsView({
    webPreferences: {
      // Same security-critical settings as the Messenger view - DO NOT
      // WEAKEN. No preload: Marketplace needs no bridge to the app.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      session,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: true,
      plugins: false,
      webviewTag: false,
    },
  });

  const contents = created.webContents;

  // Messenger already has a view: a link to it switches back instead of
  // loading a second copy
  const backToMessenger = (): void => {
    console.log('[Marketplace] Link to Messenger - switching back');
    hideMarketplace();
  };

  const applyNavigationPolicy = (event: Electron.Event, url: string): void => {
    const target = unwrapRedirectUrl(url);

    if (isMessengerUrl(target)) {
      event.preventDefault();
      backToMessenger();
      return;
    }

    if (isInAppUrl(target)) {
      // Skip a link shim and go straight to the destination
      if (target !== url) {
        event.preventDefault();
        contents.loadURL(target).catch((error: unknown) => {
          console.error('[Marketplace] Failed to follow shim:', error);
        });
      }
      return;
    }

    event.preventDefault();
    openInBrowser(target);
  };

  contents.on('will-navigate', (event, url) => applyNavigationPolicy(event, url));
  contents.on('will-redirect', (event, url) => applyNavigationPolicy(event, url));

  // Safety net: a navigation that slipped past the checks above
  contents.on('did-navigate', (_event, url) => {
    if (isMessengerUrl(url)) backToMessenger();
  });

  // Never open windows of our own: in-app links load in this view,
  // everything else goes to the browser
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('about:')) return { action: 'deny' };

    const target = unwrapRedirectUrl(url);
    if (isMessengerUrl(target)) {
      backToMessenger();
    } else if (isInAppUrl(target)) {
      contents.loadURL(target).catch((error: unknown) => {
        console.error('[Marketplace] Failed to load link:', error);
      });
    } else {
      openInBrowser(target);
    }
    return { action: 'deny' };
  });

  // Same bounds as the Messenger view: everything below the title bar
  window.contentView.addChildView(created);
  const updateBounds = (): void => {
    const bounds = window.getContentBounds();
    created.setBounds({
      x: 0,
      y: TITLE_BAR_HEIGHT,
      width: bounds.width,
      height: bounds.height - TITLE_BAR_HEIGHT,
    });
  };
  window.on('resize', updateBounds);
  window.on('maximize', updateBounds);
  window.on('unmaximize', updateBounds);
  window.on('enter-full-screen', updateBounds);
  window.on('leave-full-screen', updateBounds);
  removeBoundsListeners = (): void => {
    if (window.isDestroyed()) return;
    window.removeListener('resize', updateBounds);
    window.removeListener('maximize', updateBounds);
    window.removeListener('unmaximize', updateBounds);
    window.removeListener('enter-full-screen', updateBounds);
    window.removeListener('leave-full-screen', updateBounds);
  };
  updateBounds();

  // Hidden until the overlays say otherwise
  created.setVisible(false);

  options.onViewCreated(created);
  contents.loadURL(MARKETPLACE_URL).catch((error: unknown) => {
    console.warn('[Marketplace] Load did not complete:', error);
  });

  return created;
}

/** Show Marketplace, creating its view on first use. */
export function showMarketplace(): void {
  if (!view || view.webContents.isDestroyed()) {
    view = createView();
    if (!view) return;
  }
  setShowing(true);
}

/** Back to Messenger, exactly as it was left. Marketplace stays loaded. */
export function hideMarketplace(): void {
  setShowing(false);
}

export function toggleMarketplace(): void {
  if (showing) {
    hideMarketplace();
  } else {
    showMarketplace();
  }
}

/**
 * Close Marketplace for good: back to Messenger and the view destroyed,
 * so nothing from a session that is being cleared stays loaded.
 */
export function closeMarketplace(): void {
  setShowing(false);

  const closing = view;
  view = null;
  removeBoundsListeners?.();
  removeBoundsListeners = null;
  if (!closing) return;

  if (options && !options.window.isDestroyed()) {
    options.window.contentView.removeChildView(closing);
  }
  if (!closing.webContents.isDestroyed()) {
    closing.webContents.close();
  }
}
