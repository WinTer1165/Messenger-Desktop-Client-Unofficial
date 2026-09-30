/**
 * App Lock
 *
 * An optional PIN that hides Messenger on this computer, for shared
 * machines. While locked, the Messenger view is hidden (the 'lock'
 * overlay), the title bar document shows the lock screen, and
 * notification cards stop showing names and message text.
 *
 * When it locks is the user's choice (see AppLockMode): at startup only,
 * whenever the window comes back from the tray or the taskbar, or after
 * the window has gone unused for a while.
 *
 * This is a privacy screen, not encryption - Messenger's data on disk is
 * unchanged. The PIN is stored only as a salted scrypt hash, and wrong
 * guesses slow down after a few tries. Forgetting the PIN means signing
 * out (see main.ts), so the lock can't be bypassed without losing the
 * login.
 */

import { BrowserWindow, powerMonitor } from 'electron';
import * as crypto from 'crypto';
import * as settings from './settings';
import { AppLockMode, LockResult } from '../shared/types';

/** 4-12 digits */
const PIN_PATTERN = /^\d{4,12}$/;

/** Wrong PINs allowed before each further try has to wait */
const FREE_ATTEMPTS = 5;

/** First wait after too many wrong PINs; doubles each time */
const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 5 * 60_000;

let notify: ((locked: boolean) => void) | null = null;
let locked = false;
let awayTimer: NodeJS.Timeout | null = null;
let failedAttempts = 0;
let retryAfter = 0;
let systemEventsRegistered = false;

// ═══════════════════════════════════════════════════════════════════
// PIN
// ═══════════════════════════════════════════════════════════════════

function hashPin(pin: string, salt: string): Buffer {
  return crypto.scryptSync(pin, salt, 32);
}

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

export function hasPin(): boolean {
  return settings.getAppLockPin().hash !== '';
}

/** Check a PIN against the stored hash, slowing down repeated misses. */
function checkPin(pin: unknown): LockResult {
  const now = Date.now();
  if (now < retryAfter) {
    return { ok: false, error: 'wrong-pin', retryAfterMs: retryAfter - now };
  }

  const { hash, salt } = settings.getAppLockPin();
  if (hash === '') {
    return { ok: false, error: 'no-pin' };
  }

  const stored = Buffer.from(hash, 'hex');
  const candidate = isValidPin(pin) ? hashPin(pin, salt) : null;
  const matches =
    candidate !== null &&
    candidate.length === stored.length &&
    crypto.timingSafeEqual(candidate, stored);

  if (matches) {
    failedAttempts = 0;
    retryAfter = 0;
    return { ok: true };
  }

  failedAttempts++;
  if (failedAttempts >= FREE_ATTEMPTS) {
    const delay = Math.min(
      FIRST_DELAY_MS * 2 ** (failedAttempts - FREE_ATTEMPTS),
      MAX_DELAY_MS
    );
    retryAfter = now + delay;
    return { ok: false, error: 'wrong-pin', retryAfterMs: delay };
  }
  return { ok: false, error: 'wrong-pin' };
}

// ═══════════════════════════════════════════════════════════════════
// LOCKING
// ═══════════════════════════════════════════════════════════════════

function isEnabled(): boolean {
  return settings.getAppLockMode() !== 'off' && hasPin();
}

/** Whether a lock is set up (so the app will start locked). */
export function isLockSetUp(): boolean {
  return isEnabled();
}

export function isLocked(): boolean {
  return locked;
}

function clearAwayTimer(): void {
  if (awayTimer) {
    clearTimeout(awayTimer);
    awayTimer = null;
  }
}

function setLocked(value: boolean, reason: string): void {
  clearAwayTimer();
  if (locked === value) return;

  locked = value;
  console.log(`[AppLock] ${value ? 'Locked' : 'Unlocked'} (${reason})`);
  notify?.(value);
}

/** Lock now, if a lock is set up (Lock Now, and the automatic triggers). */
export function lock(reason = 'requested'): void {
  if (isEnabled()) {
    setLocked(true, reason);
  }
}

/** 'away' mode: count down while the window goes unused. */
function startAwayTimer(): void {
  if (settings.getAppLockMode() !== 'away' || !isEnabled() || locked || awayTimer) return;

  const minutes = settings.getAppLockAwayMinutes();
  awayTimer = setTimeout(() => {
    awayTimer = null;
    lock(`unused for ${minutes} min`);
  }, minutes * 60_000);
}

export function unlock(pin: unknown): LockResult {
  if (!locked) return { ok: true };

  const result = checkPin(pin);
  if (result.ok) {
    setLocked(false, 'PIN entered');
  }
  return result;
}

/** Set a new PIN. When one is already set, the current PIN is required. */
export function changePin(currentPin: unknown, newPin: unknown): LockResult {
  if (locked) return { ok: false, error: 'locked' };
  if (!isValidPin(newPin)) return { ok: false, error: 'invalid-pin' };

  if (hasPin()) {
    const check = checkPin(currentPin);
    if (!check.ok) return check;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  settings.setAppLockPin(hashPin(newPin, salt).toString('hex'), salt);
  console.log('[AppLock] PIN set');
  return { ok: true };
}

/**
 * Change when the app locks. Needs the PIN whenever one is set, and
 * turning the lock off also forgets the PIN.
 */
export function setMode(mode: AppLockMode, pin: unknown): LockResult {
  if (locked) return { ok: false, error: 'locked' };
  if (mode !== 'off' && !hasPin()) return { ok: false, error: 'no-pin' };

  if (hasPin()) {
    const check = checkPin(pin);
    if (!check.ok) return check;
  }

  settings.setAppLockMode(mode);
  if (mode === 'off') {
    settings.setAppLockPin('', '');
  }
  clearAwayTimer();
  console.log(`[AppLock] Mode: ${mode}`);
  return { ok: true };
}

/**
 * After signing out for a forgotten PIN (see main.ts): forget the PIN,
 * turn the lock off and unlock. The caller has already cleared the
 * Messenger session and loaded the login page.
 */
export function resetAfterSignOut(): void {
  settings.setAppLockMode('off');
  settings.setAppLockPin('', '');
  failedAttempts = 0;
  retryAfter = 0;
  setLocked(false, 'signed out after a forgotten PIN');
}

/**
 * Wire the lock triggers to the window and lock right away if a lock is
 * set up (every mode locks at startup).
 *
 * @param onLockChange - shows or hides the lock screen
 */
export function initializeAppLock(
  mainWindow: BrowserWindow,
  onLockChange: (locked: boolean) => void
): void {
  notify = onLockChange;

  // The window leaving: 'open' locks straight away, 'away' starts counting
  const onLeave = (reason: string): void => {
    const mode = settings.getAppLockMode();
    if (mode === 'open') {
      lock(reason);
    } else if (mode === 'away') {
      startAwayTimer();
    }
  };

  mainWindow.on('hide', () => onLeave('window hidden'));
  mainWindow.on('minimize', () => onLeave('window minimized'));
  mainWindow.on('blur', () => startAwayTimer());
  mainWindow.on('focus', () => clearAwayTimer());

  // The computer locking or sleeping counts as leaving for good
  if (!systemEventsRegistered) {
    systemEventsRegistered = true;
    const onSystemAway = (reason: string): void => {
      const mode = settings.getAppLockMode();
      if (mode === 'open' || mode === 'away') {
        lock(reason);
      }
    };
    powerMonitor.on('lock-screen', () => onSystemAway('computer locked'));
    powerMonitor.on('suspend', () => onSystemAway('computer went to sleep'));
  }

  if (isEnabled()) {
    setLocked(true, 'app started');
  }
}

/** Stop the away timer (app quit). */
export function stopAppLock(): void {
  clearAwayTimer();
  notify = null;
}
