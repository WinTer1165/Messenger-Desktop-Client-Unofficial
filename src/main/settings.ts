/**
 * Settings Module
 *
 * Single persistent store for user preferences, shared by the main
 * process modules (main, ipc-handlers, tray, notifications, app lock).
 * The settings page in the title bar document reads a snapshot and asks
 * the main process for changes; onChange() lets every surface (settings
 * page, tray menu) follow along, whoever made the change.
 *
 * Uses the default electron-store file name ('config.json') so values
 * saved by earlier versions (hasLoggedIn, theme, ...) are preserved.
 */

import { app } from 'electron';
import ElectronStore from 'electron-store';
import {
  AppLockMode,
  AppSettings,
  CustomTheme,
  MAX_CUSTOM_THEMES,
  ThemeId,
  ThemeSetting,
  VALID_THEMES,
} from '../shared/types';
import { validateCustomTheme } from './custom-theme-validator';

interface SettingsSchema {
  hasLoggedIn: boolean;
  minimizeToTray: boolean;
  doNotDisturb: boolean;
  keepNotificationsOnScreen: boolean;
  hideMessagePreviews: boolean;
  pauseNotificationsDuringCalls: boolean;
  themeMessenger: boolean;
  theme: ThemeId;
  customThemes: CustomTheme[];
  appLockMode: AppLockMode;
  appLockAwayMinutes: number;
  /** scrypt hash of the lock PIN (hex), empty when no PIN is set */
  appLockPinHash: string;
  appLockPinSalt: string;
}

type SettingKey = keyof SettingsSchema;

/** What changed: a stored setting, or start-with-system (kept by the OS) */
export type ChangeKey = SettingKey | 'startWithSystem';
type Listener = (key: ChangeKey) => void;

const store = new ElectronStore<SettingsSchema>({
  defaults: {
    hasLoggedIn: false,
    minimizeToTray: false,
    doNotDisturb: false,
    keepNotificationsOnScreen: true,
    hideMessagePreviews: false,
    pauseNotificationsDuringCalls: true,
    themeMessenger: true,
    theme: 'dark',
    customThemes: [],
    appLockMode: 'off',
    appLockAwayMinutes: 5,
    appLockPinHash: '',
    appLockPinSalt: '',
  },
}) as ElectronStore<SettingsSchema> & {
  get<K extends SettingKey>(key: K): SettingsSchema[K];
  set<K extends SettingKey>(key: K, value: SettingsSchema[K]): void;
};

const listeners = new Set<Listener>();

/** Subscribe to changes of any setting. */
export function onChange(listener: Listener): void {
  listeners.add(listener);
}

/** Tell subscribers a setting changed (also used for settings kept outside this store). */
export function notifyChange(key: ChangeKey): void {
  for (const listener of listeners) {
    try {
      listener(key);
    } catch (error) {
      console.error('[Settings] Listener failed:', error);
    }
  }
}

function set<K extends SettingKey>(key: K, value: SettingsSchema[K]): void {
  store.set(key, value);
  notifyChange(key);
}

export function getHasLoggedIn(): boolean {
  return store.get('hasLoggedIn');
}

export function setHasLoggedIn(value: boolean): void {
  set('hasLoggedIn', value);
}

export function getMinimizeToTray(): boolean {
  return store.get('minimizeToTray');
}

export function setMinimizeToTray(value: boolean): void {
  set('minimizeToTray', value);
}

export function getDoNotDisturb(): boolean {
  return store.get('doNotDisturb');
}

export function setDoNotDisturb(value: boolean): void {
  set('doNotDisturb', value);
}

export function getKeepNotificationsOnScreen(): boolean {
  return store.get('keepNotificationsOnScreen');
}

export function setKeepNotificationsOnScreen(value: boolean): void {
  set('keepNotificationsOnScreen', value);
}

export function getHideMessagePreviews(): boolean {
  return store.get('hideMessagePreviews');
}

export function setHideMessagePreviews(value: boolean): void {
  set('hideMessagePreviews', value);
}

export function getPauseNotificationsDuringCalls(): boolean {
  return store.get('pauseNotificationsDuringCalls');
}

export function setPauseNotificationsDuringCalls(value: boolean): void {
  set('pauseNotificationsDuringCalls', value);
}

export function getThemeMessenger(): boolean {
  return store.get('themeMessenger');
}

export function setThemeMessenger(value: boolean): void {
  set('themeMessenger', value);
}

/**
 * The saved custom themes. What is on disk is validated again here: the
 * settings file is editable, and nothing unvalidated may reach CSS.
 */
export function getCustomThemes(): CustomTheme[] {
  const stored: unknown = store.get('customThemes');
  if (!Array.isArray(stored)) return [];

  const themes: CustomTheme[] = [];
  for (const entry of stored as unknown[]) {
    const theme = validateCustomTheme(entry);
    if (theme && !themes.some((other) => other.id === theme.id)) themes.push(theme);
  }
  return themes.slice(0, MAX_CUSTOM_THEMES);
}

export function setCustomThemes(themes: CustomTheme[]): void {
  set('customThemes', themes);
}

export function isBuiltInTheme(theme: string): theme is ThemeSetting {
  return (VALID_THEMES as readonly string[]).includes(theme);
}

/** Whether `theme` is a built-in theme or the id of a saved custom theme. */
export function isKnownTheme(theme: string): theme is ThemeId {
  return isBuiltInTheme(theme) || getCustomThemes().some((custom) => custom.id === theme);
}

export function getTheme(): ThemeId {
  const theme: string = store.get('theme');
  return isKnownTheme(theme) ? theme : 'dark';
}

export function setTheme(value: ThemeId): void {
  set('theme', value);
}

export function getAppLockMode(): AppLockMode {
  return store.get('appLockMode');
}

export function setAppLockMode(value: AppLockMode): void {
  set('appLockMode', value);
}

export function getAppLockAwayMinutes(): number {
  return store.get('appLockAwayMinutes');
}

export function setAppLockAwayMinutes(value: number): void {
  set('appLockAwayMinutes', value);
}

export function getAppLockPin(): { hash: string; salt: string } {
  return { hash: store.get('appLockPinHash'), salt: store.get('appLockPinSalt') };
}

/** Store a PIN hash, or clear it with empty strings. */
export function setAppLockPin(hash: string, salt: string): void {
  store.set('appLockPinSalt', salt);
  set('appLockPinHash', hash);
}

/** Start with the system is kept by the OS, not in this store. */
export function getStartWithSystem(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

export function setStartWithSystem(value: boolean): void {
  app.setLoginItemSettings({ openAtLogin: value });
  notifyChange('startWithSystem');
}

/** Everything the settings page shows. */
export function getSnapshot(): AppSettings {
  return {
    theme: getTheme(),
    customThemes: getCustomThemes(),
    doNotDisturb: getDoNotDisturb(),
    keepNotificationsOnScreen: getKeepNotificationsOnScreen(),
    hideMessagePreviews: getHideMessagePreviews(),
    pauseNotificationsDuringCalls: getPauseNotificationsDuringCalls(),
    minimizeToTray: getMinimizeToTray(),
    startWithSystem: getStartWithSystem(),
    themeMessenger: getThemeMessenger(),
    appLock: {
      mode: getAppLockMode(),
      awayMinutes: getAppLockAwayMinutes(),
      hasPin: getAppLockPin().hash !== '',
    },
  };
}
