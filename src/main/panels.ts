/**
 * Collapsible panels
 *
 * Lets the user hide Messenger's chat list (left) and its conversation
 * information panel (right) from the title bar, so the conversation can
 * have the whole window.
 *
 * Presentation only: the panels are hidden with CSS and Messenger's own
 * state is left alone, so showing one again brings it back exactly as it
 * was.
 *
 * FRAGILITY WARNING:
 * Messenger's class names are generated and change with every deploy, so
 * the panels are found by their ARIA roles and their place in the layout
 * instead. If Messenger's markup changes enough that a panel can't be
 * found, nothing is hidden and its button does nothing - the page is
 * never left broken.
 */

import { WebContents } from 'electron';
import * as settings from './settings';

const PANELS_CSS = `
html.mdw-hide-chats [data-mdw-panel="chats"],
html.mdw-hide-info [data-mdw-panel="info"] {
  display: none !important;
}
`;

/**
 * Finds the two panels and marks them for PANELS_CSS. Messenger is a
 * single-page app that re-creates these elements as the user moves
 * around, so the marks are re-checked whenever the page changes.
 */
const PANELS_SCRIPT = `
  (function() {
    if (window.__mdwPanels) return;

    const MARK = 'data-mdw-panel';
    // A panel is a tall block: at least this much of the window's height
    const MIN_PANEL_HEIGHT = 0.5;
    const MIN_INFO_WIDTH = 180;

    function marked(name) {
      return document.querySelector('[' + MARK + '="' + name + '"]');
    }

    function mark(name, el) {
      const current = marked(name);
      if (current === el) return;
      if (current) current.removeAttribute(MARK);
      if (el) el.setAttribute(MARK, name);
    }

    // The chat list: the column holding the navigation with the grid of
    // conversations - its outermost ancestor that doesn't also hold the
    // open conversation.
    function findChats(main) {
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

    // The information panel: a tall block directly to the right of the
    // conversation. Starting at the message box and walking outwards,
    // it is the first such block found beside the path.
    function findInfo(main, chats) {
      if (!main) return null;
      const anchor =
        main.querySelector('[role="textbox"][contenteditable="true"]') ||
        main.querySelector('[role="grid"]');
      if (!anchor) return null;

      const minHeight = window.innerHeight * MIN_PANEL_HEIGHT;
      let node = anchor;
      while (node.parentElement && node !== document.body) {
        const parent = node.parentElement;
        // Past the point where the chat list branches off, there is
        // nothing of the conversation left to look beside
        if (chats && parent.contains(chats)) break;

        const nodeRect = node.getBoundingClientRect();
        for (const sibling of parent.children) {
          if (sibling === node) continue;
          const rect = sibling.getBoundingClientRect();
          if (
            rect.width >= MIN_INFO_WIDTH &&
            rect.height >= minHeight &&
            rect.left >= nodeRect.right - 2
          ) {
            return sibling;
          }
        }
        node = parent;
      }
      return null;
    }

    function update() {
      const root = document.documentElement;
      const main = document.querySelector('[role="main"]');

      // A hidden panel has no size to measure, so a mark is kept for as
      // long as its element is still part of the page
      let chats = marked('chats');
      if (!chats || !root.classList.contains('mdw-hide-chats')) {
        chats = findChats(main);
        mark('chats', chats);
      }

      if (!marked('info') || !root.classList.contains('mdw-hide-info')) {
        mark('info', findInfo(main, chats));
      }
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
      set(hideChats, hideInfo) {
        // Find the panels while they are still visible
        update();
        const root = document.documentElement;
        root.classList.toggle('mdw-hide-chats', hideChats);
        root.classList.toggle('mdw-hide-info', hideInfo);
        return { chats: marked('chats') !== null, info: marked('info') !== null };
      },
    };

    new MutationObserver(queueUpdate).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', queueUpdate);
    update();
  })();
`;

/**
 * Push the saved panel state to Messenger's page. Safe to call at any
 * time; does nothing until injectPanels has run on the current page.
 */
export async function applyPanelState(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return;

  const hideChats = settings.getHideChatList();
  const hideInfo = settings.getHideChatInfo();

  try {
    const found = (await contents.executeJavaScript(
      `window.__mdwPanels ? window.__mdwPanels.set(${String(hideChats)}, ${String(hideInfo)}) : null`
    )) as { chats: boolean; info: boolean } | null;

    if (found && hideChats && !found.chats) {
      console.warn('[Panels] Chat list not found - nothing to hide');
    }
  } catch (error) {
    console.error('[Panels] Failed to apply panel state:', error);
  }
}

/**
 * Set the panels up on a freshly loaded page and apply the saved state.
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
