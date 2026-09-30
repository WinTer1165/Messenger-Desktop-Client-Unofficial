/**
 * Connectivity
 *
 * Keeps the app usable when Messenger can't be reached - at startup with
 * the Wi-Fi down, or right after the device wakes before the network is
 * back. A failed load used to leave the chat view blank, and at startup
 * it aborted initialisation and quit the app.
 *
 * Instead, the chat view is hidden (the 'offline' overlay), uncovering
 * the title bar document underneath it, which shows a local "You're
 * offline" screen with a Retry button. While offline, Messenger is reloaded automatically as soon as
 * the connection returns.
 *
 * Only failed page loads switch to the offline screen. An already loaded
 * Messenger that loses its connection handles that itself and reconnects
 * without a reload, so it is left alone.
 */

import { net, WebContentsView } from 'electron';
import { MESSENGER_URL, ConnectionStatus } from '../shared/types';

// ═══════════════════════════════════════════════════════════════════
// TIMING
// ═══════════════════════════════════════════════════════════════════

/** First automatic retry delay; doubles after each failure. */
const RETRY_MIN_MS = 3_000;

/** Longest wait between automatic retries. */
const RETRY_MAX_MS = 60_000;

/** How often the OS network state is checked while offline. */
const POLL_INTERVAL_MS = 2_000;

/** A retry that neither loads nor fails by now is treated as failed. */
const ATTEMPT_TIMEOUT_MS = 30_000;

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let view: WebContentsView | null = null;
let notify: ((status: ConnectionStatus) => void) | null = null;

let state: ConnectionStatus['state'] = 'online';
let retryDelay = RETRY_MIN_MS;
let nextAttemptAt = 0;
let networkWasAvailable = true;

let pollTimer: NodeJS.Timeout | null = null;
let attemptTimer: NodeJS.Timeout | null = null;

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

/**
 * Whether a Chromium net error means the network itself failed: the
 * -1xx connection range, the -8xx DNS range, a timeout, or the network
 * changing mid-load. Certificate, HTTP and cache errors are problems
 * with the page, not with being offline, so they don't count.
 */
export function isConnectionError(errorCode: number): boolean {
  return (
    (errorCode <= -100 && errorCode >= -199) ||
    (errorCode <= -800 && errorCode >= -899) ||
    errorCode === -7 || // ERR_TIMED_OUT
    errorCode === -21 // ERR_NETWORK_CHANGED
  );
}

export function getStatus(): ConnectionStatus {
  return { state, networkAvailable: net.isOnline() };
}

function publish(): void {
  notify?.(getStatus());
}

function clearAttemptTimer(): void {
  if (attemptTimer) {
    clearTimeout(attemptTimer);
    attemptTimer = null;
  }
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Load Messenger again. The outcome arrives through the view's
 * did-navigate (handleNavigated) or did-fail-load (handleLoadFailure).
 */
function attempt(): void {
  if (state !== 'offline' || !view || view.webContents.isDestroyed()) return;

  console.log('[Connectivity] Retrying Messenger...');
  state = 'connecting';
  publish();

  // A navigation our own policy cancels reports neither success nor
  // failure - don't let that leave the screen stuck on "Connecting"
  clearAttemptTimer();
  attemptTimer = setTimeout(() => {
    attemptTimer = null;
    if (state === 'connecting') {
      state = 'offline';
      nextAttemptAt = Date.now() + retryDelay;
      publish();
    }
  }, ATTEMPT_TIMEOUT_MS);

  view.webContents.loadURL(MESSENGER_URL).catch(() => {
    // Handled by the did-fail-load listener
  });
}

/**
 * While offline: retry on a backoff whenever the OS reports a
 * connection, and straight away when one comes back.
 */
function poll(): void {
  if (state !== 'offline') return; // 'connecting' waits for its outcome

  const networkAvailable = net.isOnline();

  if (networkAvailable !== networkWasAvailable) {
    networkWasAvailable = networkAvailable;
    console.log(`[Connectivity] OS network ${networkAvailable ? 'available' : 'lost'}`);

    if (networkAvailable) {
      // Just reconnected (e.g. woke from sleep) - try right away
      retryDelay = RETRY_MIN_MS;
      nextAttemptAt = 0;
    }

    publish(); // The offline screen words this differently
  }

  if (networkAvailable && Date.now() >= nextAttemptAt) {
    attempt();
  }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * @param messengerView - the chat view to reload
 * @param onStatusChange - shows or hides the offline screen
 */
export function initializeConnectivity(
  messengerView: WebContentsView,
  onStatusChange: (status: ConnectionStatus) => void
): void {
  stopConnectivity(); // Re-initialising (macOS) starts from a clean slate
  state = 'online';
  view = messengerView;
  notify = onStatusChange;
}

/**
 * A main-frame load failed. Returns true when it was a connection
 * problem, which is now being handled by the offline screen.
 */
export function handleLoadFailure(errorCode: number): boolean {
  if (!isConnectionError(errorCode)) return false;

  clearAttemptTimer();

  if (state === 'online') {
    console.log('[Connectivity] Messenger unreachable - showing offline screen');
    retryDelay = RETRY_MIN_MS;
    networkWasAvailable = net.isOnline();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  state = 'offline';
  nextAttemptAt = Date.now() + retryDelay;
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  publish();
  return true;
}

/** The view committed a real page, so the network works again. */
export function handleNavigated(): void {
  if (state === 'online') return;

  console.log('[Connectivity] Connected - showing Messenger');
  state = 'online';
  stopPolling();
  clearAttemptTimer();
  publish();
}

/** Retry button: try now and restart the backoff. */
export function retryNow(): void {
  retryDelay = RETRY_MIN_MS;
  attempt();
}

/** Stop timers (app quit). */
export function stopConnectivity(): void {
  stopPolling();
  clearAttemptTimer();
  view = null;
  notify = null;
}
