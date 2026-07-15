/**
 * Settings Module
 *
 * Single persistent store for user preferences, shared by the main
 * process modules (main, ipc-handlers, tray).
 *
 * Uses the default electron-store file name ('config.json') so values
 * saved by earlier versions (hasLoggedIn) are preserved.
 */

import ElectronStore from 'electron-store';
import { ThemeSetting } from '../shared/types';

interface SettingsSchema {
  hasLoggedIn: boolean;
  minimizeToTray: boolean;
  doNotDisturb: boolean;
  theme: ThemeSetting;
}

const store = new ElectronStore<SettingsSchema>({
  defaults: {
    hasLoggedIn: false,
    minimizeToTray: false,
    doNotDisturb: false,
    theme: 'dark',
  },
}) as ElectronStore<SettingsSchema> & {
  get<K extends keyof SettingsSchema>(key: K): SettingsSchema[K];
  set<K extends keyof SettingsSchema>(key: K, value: SettingsSchema[K]): void;
};

export function getHasLoggedIn(): boolean {
  return store.get('hasLoggedIn');
}

export function setHasLoggedIn(value: boolean): void {
  store.set('hasLoggedIn', value);
}

export function getMinimizeToTray(): boolean {
  return store.get('minimizeToTray');
}

export function setMinimizeToTray(value: boolean): void {
  store.set('minimizeToTray', value);
}

export function getDoNotDisturb(): boolean {
  return store.get('doNotDisturb');
}

export function setDoNotDisturb(value: boolean): void {
  store.set('doNotDisturb', value);
}

export function getTheme(): ThemeSetting {
  return store.get('theme');
}

export function setTheme(value: ThemeSetting): void {
  store.set('theme', value);
}
