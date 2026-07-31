/**
 * Navigation Policy
 *
 * Decides which URLs render inside the app and which are handed to the
 * user's default browser.
 *
 * WHY THIS MODULE EXISTS:
 * Messenger wraps every external link in its click-tracking redirector
 * (https://l.messenger.com/l.php?u=<real target>). That host looks like
 * an ordinary messenger.com subdomain, so a plain hostname allowlist
 * lets it navigate the chat view onto a blank interstitial before the
 * hop to the real (external) target gets blocked - leaving the window
 * white with no way back except the Home button. Unwrapping the
 * redirector first means every decision is made against the real
 * destination.
 */

import { shell } from 'electron';

// ═══════════════════════════════════════════════════════════════════
// HOST CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Link shims. These only ever bounce somewhere else, so they are never
 * a valid destination for the view to sit on.
 */
const REDIRECTOR_HOSTS = new Set([
  'l.messenger.com',
  'l.facebook.com',
  'lm.facebook.com',
  'l.instagram.com',
]);

/** Query parameters the shims carry the real target in. */
const REDIRECT_TARGET_PARAMS = ['u', 'url', 'next'];

/** Redirectors can nest - bound the unwrapping so a loop can't hang us. */
const MAX_UNWRAP_DEPTH = 5;

/** Hosts allowed to render inside the app window. */
const IN_APP_HOST_PATTERNS = [
  /^(www\.)?messenger\.com$/,
  /^(www\.)?facebook\.com$/,
  /^.+\.messenger\.com$/,
  /^.+\.facebook\.com$/,
  /^.+\.fbcdn\.net$/, // Media CDN
  /^.+\.fbsbx\.com$/, // Attachment sandbox
];

/**
 * Hosts allowed to open a window of their own (calls, media popups).
 * Deliberately narrower than the in-app list: a facebook.com popup is
 * a web page, not part of the Messenger UI, so it belongs in a browser.
 */
const POPUP_HOST_PATTERNS = [
  /^(www\.)?messenger\.com$/,
  /^.+\.messenger\.com$/,
  /^.+\.fbcdn\.net$/,
];

/** Call and room URLs get their own window instead of replacing the chat. */
const CALL_PATH_PATTERN = /call|room/i;

/** Schemes we are willing to hand to the OS. */
const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:']);

// ═══════════════════════════════════════════════════════════════════
// URL HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse a URL without throwing. Navigation events can carry anything,
 * and an exception here would take down the main process.
 */
function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * Follow a link shim to the URL it actually points at.
 * Returns the input unchanged when it isn't a shim.
 */
export function unwrapRedirectUrl(rawUrl: string): string {
  let current = rawUrl;

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const parsed = parseUrl(current);

    if (!parsed || !REDIRECTOR_HOSTS.has(parsed.hostname.toLowerCase())) {
      return current;
    }

    let target: string | null = null;

    for (const param of REDIRECT_TARGET_PARAMS) {
      const value = parsed.searchParams.get(param);
      if (value !== null && value.length > 0) {
        target = value;
        break;
      }
    }

    if (target === null) {
      return current; // Shim with no target we recognise - treat as-is
    }

    current = target;
  }

  return current;
}

function matchesHost(rawUrl: string, patterns: RegExp[]): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return false;

  const host = parsed.hostname.toLowerCase();

  // A shim is never the destination - callers unwrap first
  if (REDIRECTOR_HOSTS.has(host)) return false;

  return patterns.some((pattern) => pattern.test(host));
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/** Whether a URL may render inside the app window. */
export function isInAppUrl(rawUrl: string): boolean {
  return matchesHost(rawUrl, IN_APP_HOST_PATTERNS);
}

/** Whether a URL may open as a window of its own. */
export function isPopupUrl(rawUrl: string): boolean {
  return matchesHost(rawUrl, POPUP_HOST_PATTERNS);
}

/** Whether a URL is a call/room that should get its own window. */
export function isCallUrl(rawUrl: string): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return false;

  return CALL_PATH_PATTERN.test(parsed.pathname);
}

/**
 * Open a URL in the user's default browser.
 * Unwraps link shims first and refuses schemes we don't hand to the OS.
 */
export function openInBrowser(rawUrl: string): void {
  const target = unwrapRedirectUrl(rawUrl);
  const parsed = parseUrl(target);

  if (!parsed || !EXTERNAL_SCHEMES.has(parsed.protocol)) {
    console.warn('[Navigation] Refused to open externally:', rawUrl);
    return;
  }

  console.log('[Navigation] Opening in browser:', target);
  void shell.openExternal(target);
}
