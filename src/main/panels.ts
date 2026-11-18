/**
 * Collapsible chat list
 *
 * Lets the user hide Messenger's chat list (the left column) from the
 * title bar, so the conversation can have the whole window. Messenger
 * can already hide its right-hand information panel itself (the "i"
 * button in a conversation's header); the chat list is the one it
 * offers no way to collapse.
 *
 * Presentation only: the list is hidden with CSS and Messenger's own
 * state is left alone, so showing it again brings it back exactly as it
 * was.
 *
 * FRAGILITY WARNING:
 * Messenger's class names are generated and change with every deploy, so
 * the list is found by its ARIA roles and its place in the layout
 * instead. If Messenger's markup changes enough that it can't be found,
 * nothing is hidden and the button does nothing - the page is never
 * left broken.
 */

import { WebContents } from 'electron';
import * as settings from './settings';

const PANELS_CSS = `
html.mdw-hide-chats [data-mdw-panel="chats"] {
  display: none !important;
}
`;

/**
 * Finds the chat list and marks it for PANELS_CSS. Messenger is a
 * single-page app that re-creates its elements as the user moves
 * around, so the mark is re-checked whenever the page changes.
 */
const PANELS_SCRIPT = `
  (function() {
    if (window.__mdwPanels) return;

    const MARK = 'data-mdw-panel';

    function marked() {
      return document.querySelector('[' + MARK + '="chats"]');
    }

    // The chat list: the column holding the navigation with the grid of
    // conversations - its outermost ancestor that doesn't also hold the
    // open conversation.
    function findChats() {
      const main = document.querySelector('[role="main"]');
      const grid = document.querySelector('[role="navigation"] [role="grid"]');
      const nav = grid && grid.closest('[role="navigation"]');
      if (!nav || !main || nav.contains(main)) return null;

      let column = nav;
      while (column.parentElement && !column.parentElement.contains(main)) {
        column = column.parentElement;
      }
      if (!column.parentElement) return null;

      // Something this wide is not a side column
      const width = column.getBoundingClientRect().width;
      if (width > window.innerWidth * 0.6) return null;
      return column;
    }

    function update() {
      // A hidden list has no size to measure, so its mark is kept for
      // as long as its element is still part of the page
      const current = marked();
      if (current && document.documentElement.classList.contains('mdw-hide-chats')) return;

      const found = findChats();
      if (found === current) return;
      if (current) current.removeAttribute(MARK);
      if (found) found.setAttribute(MARK, 'chats');
    }

    // Messenger mutates the page constantly; look again at most once
    // per frame, and not at all while the window is hidden
    let queued = false;
    function queueUpdate() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    }

    window.__mdwPanels = {
      set(hideChats) {
        // Find the list while it is still visible
        update();
        document.documentElement.classList.toggle('mdw-hide-chats', hideChats);
        return marked() !== null;
      },
    };

    new MutationObserver(queueUpdate).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', queueUpdate);
    update();
  })();
`;

/**
 * Push the saved state to Messenger's page. Safe to call at any time;
 * does nothing until injectPanels has run on the current page.
 */
export async function applyPanelState(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return;

  const hideChats = settings.getHideChatList();

  try {
    const found = (await contents.executeJavaScript(
      `window.__mdwPanels ? window.__mdwPanels.set(${String(hideChats)}) : null`
    )) as boolean | null;

    if (found === false && hideChats) {
      console.warn('[Panels] Chat list not found - nothing to hide');
    }
  } catch (error) {
    console.error('[Panels] Failed to apply panel state:', error);
  }
}

/**
 * Set the chat list up on a freshly loaded page and apply the saved state.
 */
export async function injectPanels(contents: WebContents): Promise<void> {
  try {
    await contents.insertCSS(PANELS_CSS);
    await contents.executeJavaScript(PANELS_SCRIPT);
  } catch (error) {
    console.error('[Panels] Failed to inject:', error);
    return;
  }
  await applyPanelState(contents);
}
