/**
 * Notifications
 *
 * Messenger's page asks for notifications through the Notification API.
 * The script from getPageScript() stands in for that API and relays each
 * request here, where it is shown natively - on Windows as a custom
 * toast in the style of Discord's:
 *
 * - The sender's avatar, cropped round, next to their name and message.
 * - Messages stay up for KEEP_ON_SCREEN_MS (Windows' own timeout is
 *   about 5 s) and then move to the notification center. Toggled from
 *   the settings page.
 * - Incoming calls get a call-style card with Open Messenger / Dismiss
 *   that stays until handled, and the window is brought forward -
 *   without taking keyboard focus - with its taskbar button flashing.
 *   Calls are recognised by the wording of Messenger's notification
 *   (English UI).
 * - Hide message previews: "New message" instead of the text.
 * - Pause during calls: no message notifications while a call window
 *   is open.
 * - While the app lock is on, cards show no names, text or avatars.
 *
 * Clicks, closes and shows are relayed back to the page, so Messenger's
 * own handlers - like opening the right chat on click - still run.
 * macOS and Linux get the standard system notification with the same
 * rules (macOS decides itself how long a banner stays).
 */

import {
  app,
  BrowserWindow,
  nativeImage,
  NativeImage,
  Notification,
  WebContents,
} from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as settings from './settings';
import * as dnd from './do-not-disturb';
import * as appLock from './app-lock';
import { NotificationRequest } from '../shared/types';

/** How long a message notification stays up when kept on screen. */
const KEEP_ON_SCREEN_MS = 8_000;

/** Messenger's ringing-call notification, as title or body. */
const CALL_PATTERN = /^(incoming (audio |video |voice )?call|.{1,100} is calling( you)?[.…]*)$/i;

/** Avatars are fetched only from Facebook's own hosts. */
const AVATAR_HOST_PATTERN = /(^|\.)(fbcdn\.net|facebook\.com|messenger\.com)$/i;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TIMEOUT_MS = 4_000;
const AVATAR_SIZE = 96;

/** Windows toasts can only show images from local files. */
const AVATAR_DIR = path.join(app.getPath('temp'), 'messenger-desktop-avatars');

interface ShownNotification {
  notification: Notification;
  contents: WebContents;
  pageId: number;
  tag: string;
  expiry: NodeJS.Timeout | null;
}

let mainWindow: BrowserWindow | null = null;

/** Notifications on screen, by `${webContents id}:${page id}`. */
const shown = new Map<string, ShownNotification>();

/** Open call windows (children of the Messenger view). */
const callWindows = new Set<BrowserWindow>();

// ═══════════════════════════════════════════════════════════════════
// PAGE SCRIPT
// ═══════════════════════════════════════════════════════════════════

/**
 * Script for Messenger's page (main world). Replaces window.Notification
 * with a stand-in that relays to the main process through the preload
 * bridge, and exposes window.__mdwNotificationEvent(id, type) for the
 * main process to deliver show/click/close/error back.
 *
 * Without the bridge (preload failed) Messenger keeps the real API.
 */
export function getPageScript(): string {
  return `
    (function() {
      if (window.__mdwNotificationPatched) return;
      window.__mdwNotificationPatched = true;

      const NativeNotification = window.Notification;
      const bridge = window.messengerBridge;
      if (!NativeNotification || !bridge || !bridge.showNotification) return;

      // Notifications being shown for this page, by id
      const live = new Map();
      let nextId = 0;

      function fire(notification, type) {
        const event = new Event(type);
        notification.dispatchEvent(event);

        const handler = notification['on' + type];
        if (typeof handler === 'function') {
          try {
            handler.call(notification, event);
          } catch (e) {
            console.error('[NotificationPatch] Handler failed:', e);
          }
        }
      }

      class AppNotification extends EventTarget {
        #id;

        constructor(title, options) {
          super();
          const opts = options || {};

          this.title = String(title);
          this.body = typeof opts.body === 'string' ? opts.body : '';
          this.icon = typeof opts.icon === 'string' ? opts.icon : '';
          this.tag = typeof opts.tag === 'string' ? opts.tag : '';
          this.data = opts.data === undefined ? null : opts.data;
          this.silent = opts.silent === true;
          this.requireInteraction = opts.requireInteraction === true;
          this.dir = opts.dir || 'auto';
          this.lang = opts.lang || '';
          this.badge = opts.badge || '';
          this.image = opts.image || '';
          this.renotify = opts.renotify === true;
          this.timestamp = opts.timestamp || Date.now();
          this.actions = [];
          this.vibrate = [];
          this.onclick = null;
          this.onshow = null;
          this.onclose = null;
          this.onerror = null;

          this.#id = ++nextId;
          live.set(this.#id, this);
          bridge.showNotification({
            id: this.#id,
            title: this.title,
            body: this.body,
            icon: this.icon,
            tag: this.tag,
            silent: this.silent,
          });
        }

        close() {
          if (live.has(this.#id)) {
            bridge.closeNotification(this.#id);
          }
        }

        static get permission() {
          return NativeNotification.permission;
        }

        static get maxActions() {
          return NativeNotification.maxActions;
        }

        static requestPermission(callback) {
          return NativeNotification.requestPermission(callback);
        }
      }

      window.Notification = AppNotification;

      window.__mdwNotificationEvent = function(id, type) {
        const notification = live.get(id);
        if (!notification) return;

        if (type === 'close' || type === 'error') {
          live.delete(id);
        }
        fire(notification, type);
      };

      console.log('[NotificationPatch] Notifications relayed to the app');
    })();
  `;
}

// ═══════════════════════════════════════════════════════════════════
// AVATARS
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch a notification's avatar into a square PNG in the temp folder.
 * Returns null when there is none or it can't be loaded - the card is
 * then shown with the app icon instead.
 */
async function loadAvatar(
  contents: WebContents,
  url: string
): Promise<{ image: NativeImage; file: string } | null> {
  if (url === '') return null;

  try {
    let image: NativeImage;

    if (url.startsWith('data:image/')) {
      if (url.length > AVATAR_MAX_BYTES * 1.4) return null;
      image = nativeImage.createFromDataURL(url);
    } else {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !AVATAR_HOST_PATTERN.test(parsed.hostname)) {
        return null;
      }

      // Through Messenger's session, so it uses the same network setup
      const response = await contents.session.fetch(url, {
        signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
      });
      if (!response.ok) return null;

      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > AVATAR_MAX_BYTES) return null;
      image = nativeImage.createFromBuffer(data);
    }

    if (image.isEmpty()) return null;

    const square = image.resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, quality: 'best' });
    const file = path.join(
      AVATAR_DIR,
      crypto.createHash('sha1').update(url).digest('hex') + '.png'
    );
    await fs.promises.mkdir(AVATAR_DIR, { recursive: true });
    await fs.promises.writeFile(file, square.toPNG());
    return { image: square, file };
  } catch (error) {
    console.warn('[Notifications] Avatar unavailable:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// WINDOWS TOAST
// ═══════════════════════════════════════════════════════════════════

function escapeXml(text: string): string {
  return text
    // Control characters are not allowed in XML at all
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface ToastContent {
  title: string;
  body: string;
  avatarFile: string | null;
  call: boolean;
  silent: boolean;
  /** Ask Windows for its long duration; we close it at KEEP_ON_SCREEN_MS */
  keepOnScreen: boolean;
}

/**
 * Toast layout: round avatar beside the name and message, no buttons
 * for messages. Calls use Windows' call layout, which stays until one
 * of its buttons is used. Their sound is left to Messenger's own
 * ringtone, so the two don't ring over each other.
 */
function buildToastXml(content: ToastContent): string {
  const toastAttributes = content.call
    ? ' scenario="incomingCall"'
    : content.keepOnScreen
      ? ' duration="long"'
      : '';

  const avatar = content.avatarFile !== null
    ? `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(pathToFileURL(content.avatarFile).href)}"/>`
    : '';

  const body = content.body !== '' ? `<text>${escapeXml(content.body)}</text>` : '';

  const actions = content.call
    ? '<actions>' +
      '<action content="Open Messenger" arguments="open" activationType="foreground"/>' +
      '<action content="Dismiss" arguments="dismiss" activationType="system"/>' +
      '</actions>'
    : '';

  const audio = content.silent || content.call ? '<audio silent="true"/>' : '';

  return (
    `<toast${toastAttributes}>` +
    '<visual><binding template="ToastGeneric">' +
    `<text hint-maxLines="1">${escapeXml(content.title)}</text>` +
    body +
    avatar +
    '</binding></visual>' +
    actions +
    audio +
    '</toast>'
  );
}

// ═══════════════════════════════════════════════════════════════════
// SHOWING
// ═══════════════════════════════════════════════════════════════════

function keyOf(contents: WebContents, pageId: number): string {
  return `${contents.id}:${pageId}`;
}

/** Deliver show/click/close/error to the page's stand-in object. */
function relay(contents: WebContents, pageId: number, type: string): void {
  if (contents.isDestroyed()) return;

  contents
    .executeJavaScript(
      `window.__mdwNotificationEvent && window.__mdwNotificationEvent(${pageId}, ${JSON.stringify(type)})`
    )
    .catch((error: unknown) => {
      console.error('[Notifications] Relay failed:', error);
    });
}

/** Forget a notification and tell the page it is gone. */
function finish(key: string, type: 'close' | 'error'): void {
  const entry = shown.get(key);
  if (!entry) return;

  shown.delete(key);
  if (entry.expiry) {
    clearTimeout(entry.expiry);
  }
  relay(entry.contents, entry.pageId, type);
}

/**
 * Take a notification off the screen and tell the page it is gone.
 * Windows reports no close for one the app hides itself, so this
 * doesn't wait for the 'close' event.
 */
function dismiss(key: string): void {
  const entry = shown.get(key);
  if (!entry) return;

  entry.notification.close();
  finish(key, 'close');
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function isCall(request: NotificationRequest): boolean {
  return [request.title, request.body].some((text) => CALL_PATTERN.test(text.trim()));
}

/**
 * Show a notification Messenger asked for.
 *
 * @param contents - the Messenger page that asked
 */
export async function showNotification(
  contents: WebContents,
  request: NotificationRequest
): Promise<void> {
  const call = isCall(request);

  if (dnd.isEnabled()) {
    relay(contents, request.id, 'close');
    return;
  }

  if (!call && settings.getPauseNotificationsDuringCalls() && callWindows.size > 0) {
    console.log('[Notifications] Paused during a call');
    relay(contents, request.id, 'close');
    return;
  }

  // What the card may reveal
  const locked = appLock.isLocked();
  let title = request.title;
  let body = request.body;
  if (locked) {
    title = 'Messenger';
    body = call ? 'Incoming call' : 'New message';
  } else if (!call && settings.getHideMessagePreviews()) {
    body = 'New message';
  }

  // A newer notification with the same tag replaces the older one
  if (request.tag !== '') {
    for (const [key, entry] of [...shown]) {
      if (entry.contents === contents && entry.tag === request.tag) {
        dismiss(key);
      }
    }
  }

  const avatar = locked ? null : await loadAvatar(contents, request.icon);
  if (contents.isDestroyed()) return;

  const keepOnScreen = !call && settings.getKeepNotificationsOnScreen();

  const notification = process.platform === 'win32'
    ? new Notification({
        toastXml: buildToastXml({
          title,
          body,
          avatarFile: avatar?.file ?? null,
          call,
          silent: request.silent,
          keepOnScreen,
        }),
      })
    : new Notification({
        title,
        body,
        icon: avatar?.image,
        silent: request.silent,
        // Linux: never expire on their own; we close them on time
        timeoutType: call || keepOnScreen ? 'never' : 'default',
        urgency: call ? 'critical' : 'normal',
      });

  const key = keyOf(contents, request.id);
  const entry: ShownNotification = {
    notification,
    contents,
    pageId: request.id,
    tag: request.tag,
    expiry: null,
  };
  shown.set(key, entry);

  notification.on('show', () => relay(contents, request.id, 'show'));
  notification.on('click', () => {
    focusMainWindow();
    relay(contents, request.id, 'click');
    finish(key, 'close'); // Clicking a toast also dismisses it
  });
  notification.on('close', () => finish(key, 'close'));
  notification.on('failed', (_event, error) => {
    console.error('[Notifications] Failed to show:', error);
    finish(key, 'error');
  });

  notification.show();

  // macOS decides itself how long a banner stays
  if (keepOnScreen && process.platform !== 'darwin') {
    entry.expiry = setTimeout(() => dismiss(key), KEEP_ON_SCREEN_MS);
  }

  if (call) {
    handleIncomingCall();
  }
}

/** Close a notification the page is done with. */
export function closeNotification(contents: WebContents, pageId: number): void {
  dismiss(keyOf(contents, pageId));
}

/**
 * Close every notification on screen. Called when the window gains
 * focus: the user is looking at Messenger, whose own unread markers
 * take over from there.
 */
export function closeAllNotifications(): void {
  for (const key of [...shown.keys()]) {
    dismiss(key);
  }
}

/**
 * A call is ringing: make sure the window can be seen. Shown without
 * activation so it never steals keystrokes, and the taskbar/dock keeps
 * asking for attention until the window is focused.
 */
function handleIncomingCall(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;

  // Already in front of the user. A minimized window can still count
  // as focused on Windows, so that alone isn't enough.
  if (window.isFocused() && window.isVisible() && !window.isMinimized()) return;

  console.log('[Notifications] Incoming call - bringing the window forward');

  if (!window.isVisible() || window.isMinimized()) {
    window.showInactive();
  }
  window.moveTop();

  if (process.platform === 'darwin') {
    app.dock?.bounce('critical');
  } else {
    window.flashFrame(true);
  }
}

// ═══════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════

/** Count a call window (for pausing notifications during calls). */
export function trackCallWindow(window: BrowserWindow): void {
  callWindows.add(window);
  window.once('closed', () => callWindows.delete(window));
}

export function initializeNotifications(window: BrowserWindow): void {
  mainWindow = window;

  // Avatars from the last run are stale
  fs.promises.rm(AVATAR_DIR, { recursive: true, force: true }).catch(() => {
    // Nothing to clean up
  });
}

/** Close everything on screen (app quit). */
export function stopNotifications(): void {
  closeAllNotifications();
  mainWindow = null;
}
