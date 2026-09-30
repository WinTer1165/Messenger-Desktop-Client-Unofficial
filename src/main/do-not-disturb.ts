/**
 * Do Not Disturb
 *
 * One owner for the flag, so the tray checkbox, the title bar button,
 * the keyboard shortcut and the session permission handlers can never
 * disagree about whether it is on.
 *
 * The value is persisted through the shared settings store; everything
 * that needs to react to a change subscribes with settings.onChange().
 */

import * as settings from './settings';

/** Whether Do Not Disturb is currently on. */
export function isEnabled(): boolean {
  return settings.getDoNotDisturb();
}

/**
 * Set Do Not Disturb (settings.onChange() tells everyone else).
 * A no-op when the value is unchanged, so a UI echoing state back
 * cannot start a notification loop.
 */
export function setEnabled(enabled: boolean): void {
  if (enabled === settings.getDoNotDisturb()) {
    return;
  }

  settings.setDoNotDisturb(enabled);
  console.log(`[DND] Do Not Disturb ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

/** Flip Do Not Disturb. Returns the new state. */
export function toggle(): boolean {
  const next = !isEnabled();
  setEnabled(next);
  return next;
}
