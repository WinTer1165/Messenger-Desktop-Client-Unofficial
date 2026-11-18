/**
 * Mark all chats as read
 *
 * Messenger has no "mark all as read". This does what the user would do
 * by hand for each unread chat in the chat list: point at it, open its
 * "more options" menu and choose "Mark as read".
 *
 * It goes through Messenger's own menu with real mouse input, so
 * Messenger does the marking exactly as if the user had clicked - no
 * request is forged and nothing about Messenger is patched.
 *
 * LIMITS, on purpose:
 * - Only chats currently loaded in the chat list are covered (Messenger
 *   loads older ones as the list is scrolled), and at most MAX_CHATS
 *   per run.
 * - The menu item is recognised by its English label. In another
 *   language, or if Messenger renames it, nothing is clicked and the
 *   run reports that it could not mark anything - it never clicks a
 *   menu item it does not recognise.
 *
 * FRAGILITY WARNING:
 * Unread chats are recognised by Messenger's hidden "Unread" label and
 * by their bolder text, the list by its ARIA roles. Like everything
 * that reads Messenger's page, this can stop working when Messenger
 * changes; it then fails safe, as above.
 */

import { WebContents } from 'electron';

/** Outcome of a run, for the message shown afterwards. */
export interface MarkAllReadResult {
  /** Chats that were marked as read */
  marked: number;
  /** Unread chats found whose menu or menu item could not be used */
  failed: number;
  /** Why nothing could be done at all, if so */
  problem?: 'busy' | 'no-list' | 'list-hidden';
}

/** Most chats handled in one run */
const MAX_CHATS = 50;

/** Pauses that let Messenger react: show the row's button, open the menu, apply the change */
const HOVER_MS = 180;
const MENU_MS = 350;
const SETTLE_MS = 350;

/**
 * Page side: finds the unread rows and reports where to point. All the
 * clicking is done from the main process with real input events.
 */
const PAGE_SCRIPT = `
  (function() {
    if (window.__mdwReadAll) return;

    // The menu item to click. Lower case; matched against the whole label.
    const MARK_READ_LABELS = ['mark as read'];

    let attempted = new WeakSet();
    let current = null;

    function rows() {
      return [...document.querySelectorAll('[role="navigation"] [role="grid"] [role="row"]')];
    }

    function centre(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    // Average font weight of a row's text: unread chats are set bolder
    function weight(row) {
      let total = 0;
      let count = 0;
      for (const span of row.querySelectorAll('span')) {
        const ownText = [...span.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== ''
        );
        if (!ownText) continue;
        total += Number(getComputedStyle(span).fontWeight) || 400;
        count++;
      }
      return count === 0 ? 400 : total / count;
    }

    function labelledUnread(row) {
      if (/\\bunread\\b/i.test(row.textContent)) return true;
      return [...row.querySelectorAll('[aria-label]')].some((el) =>
        /\\bunread\\b/i.test(el.getAttribute('aria-label'))
      );
    }

    // Rows that look unread. A read chat picked up by mistake is
    // harmless: its menu has no "Mark as read" and it is skipped.
    function unreadRows() {
      const all = rows();
      const weights = all.map(weight);
      const lightest = Math.min(...weights);
      return all.filter((row, i) => labelledUnread(row) || weights[i] > lightest + 40);
    }

    window.__mdwReadAll = {
      start() {
        attempted = new WeakSet();
        current = null;
        const all = rows();
        if (all.length === 0) return 'no-list';
        if (!centre(all[0]) && !all.some(centre)) return 'list-hidden';
        return 'ok';
      },

      // The next unread chat, scrolled into view: where to point
      next() {
        current = unreadRows().find((row) => !attempted.has(row)) || null;
        if (!current) return null;
        attempted.add(current);
        current.scrollIntoView({ block: 'center' });
        const point = centre(current);
        // sure: Messenger itself labels it unread, so not being able to
        // mark it is a real failure rather than a wrong guess
        return point ? { x: point.x, y: point.y, sure: labelledUnread(current) } : null;
      },

      // The current chat's "more options" button, once it has appeared
      menuButton() {
        if (!current || !current.isConnected) return null;
        const button = current.querySelector('[aria-haspopup="menu"]');
        return button ? centre(button) : null;
      },

      // "Mark as read" in the open menu - or null, and nothing is clicked
      markItem() {
        const menus = document.querySelectorAll('[role="menu"]');
        const menu = menus[menus.length - 1];
        if (!menu) return null;
        for (const item of menu.querySelectorAll('[role="menuitem"]')) {
          const label = item.textContent.trim().toLowerCase();
          if (MARK_READ_LABELS.includes(label)) return centre(item);
        }
        return null;
      },

      menuOpen() {
        return document.querySelector('[role="menu"]') !== null;
      },
    };
  })();
`;

interface Point {
  x: number;
  y: number;
}

function isPoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.x === 'number' &&
    typeof point.y === 'number' &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let running = false;

/**
 * Mark every unread chat in the loaded chat list as read. The view must
 * be showing Messenger and be visible - input goes where the user's
 * mouse would.
 */
export async function markAllAsRead(contents: WebContents): Promise<MarkAllReadResult> {
  if (running) return { marked: 0, failed: 0, problem: 'busy' };
  running = true;

  const ask = (call: string): Promise<unknown> =>
    contents.executeJavaScript(`window.__mdwReadAll.${call}`);

  // Page coordinates are CSS pixels; input events count in the view's
  // own pixels, which differ once the user has zoomed
  const toView = (point: Point): { x: number; y: number } => {
    const zoom = contents.getZoomFactor();
    return { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
  };
  const moveTo = (point: Point): void => {
    contents.sendInputEvent({ type: 'mouseMove', ...toView(point) });
  };
  const click = (point: Point): void => {
    const at = toView(point);
    contents.sendInputEvent({ type: 'mouseMove', ...at });
    contents.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
  };
  const pressEscape = (): void => {
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  };

  let marked = 0;
  let failed = 0;

  try {
    await contents.executeJavaScript(PAGE_SCRIPT);

    const state = await ask('start()');
    if (state === 'no-list' || state === 'list-hidden') {
      return { marked, failed, problem: state };
    }

    for (let i = 0; i < MAX_CHATS && !contents.isDestroyed(); i++) {
      const row = await ask('next()');
      if (!isPoint(row)) break;
      const sure = (row as Point & { sure?: unknown }).sure === true;

      // Point at the chat, so Messenger shows its "more options" button
      moveTo(row);
      await wait(HOVER_MS);

      const button = await ask('menuButton()');
      if (!isPoint(button)) {
        if (sure) failed++;
        continue;
      }
      click(button);
      await wait(MENU_MS);

      const item = await ask('markItem()');
      if (isPoint(item)) {
        click(item);
        marked++;
        await wait(SETTLE_MS);
      } else {
        // Already read after all, or a label this doesn't know: close
        // the menu and leave the chat as it is
        if ((await ask('menuOpen()')) === true) {
          pressEscape();
          await wait(HOVER_MS);
        }
        if (sure) failed++;
      }
    }
  } catch (error) {
    console.error('[MarkAllRead] Stopped early:', error);
  } finally {
    running = false;
  }

  console.log(`[MarkAllRead] Marked ${String(marked)}, could not mark ${String(failed)}`);
  return { marked, failed };
}
