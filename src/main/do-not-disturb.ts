/**
 * Do Not Disturb
 *
 * One owner for the flag, so the tray checkbox, the title bar button,
 * the keyboard shortcut and the session permission handlers can never
 * disagree about whether it is on.
 *
 * The value is persisted through the shared settings store; everything
 * that needs to react to a change subscribes with onChange().
 */

import * as settings from './settings';

type Listener = (enabled: boolean) => void;

const listeners = new Set<Listener>();

/** Whether Do Not Disturb is currently on. */
export function isEnabled(): boolean {
  return settings.getDoNotDisturb();
}

/**
 * Set Do Not Disturb and notify subscribers.
 * A no-op when the value is unchanged, so a UI echoing state back
 * cannot start a notification loop.
 */
export function setEnabled(enabled: boolean): void {
  if (enabled === settings.getDoNotDisturb()) {
    return;
  }

  settings.setDoNotDisturb(enabled);
  console.log(`[DND] Do Not Disturb ${enabled ? 'ENABLED' : 'DISABLED'}`);

  for (const listener of listeners) {
    try {
      listener(enabled);
    } catch (error) {
      console.error('[DND] Listener failed:', error);
    }
  }
}

/** Flip Do Not Disturb. Returns the new state. */
export function toggle(): boolean {
  const next = !isEnabled();
  setEnabled(next);
  return next;
}

/**
 * Subscribe to changes. Listeners are held in a Set, so registering the
 * same function twice (app re-initialising on macOS) is harmless.
 */
export function onChange(listener: Listener): void {
  listeners.add(listener);
}
