/**
 * Custom theme validator
 *
 * The one gate every user-made theme passes through - from the title bar
 * (save, preview), from the settings file on disk and from the query the
 * title bar is loaded with. Nothing that has not come out of
 * validateCustomTheme() is stored, turned into CSS or applied.
 *
 * It is strict on purpose: the exact set of keys, colours as #rrggbb
 * (returned lower-cased), an id in the expected format, a short plain-text
 * name. Anything else is rejected, never repaired, so a colour can never
 * carry anything but six hex digits into a stylesheet.
 */

import type { CustomTheme, CustomThemeId } from '../shared/types';

const ID_PATTERN = /^custom-[0-9a-f]{8}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

const COLOR_KEYS = ['bg', 'fg', 'muted', 'accent', 'solid', 'barFrom', 'barTo', 'barFg'] as const;
const ALL_KEYS: readonly string[] = ['id', 'name', 'light', ...COLOR_KEYS];

export const MAX_THEME_NAME_LENGTH = 30;

/** Control characters, and the invisible or direction-changing ones. */
const UNWANTED_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function stripUnwantedChars(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (!UNWANTED_RANGES.some(([from, to]) => code >= from && code <= to)) {
      result += text[index];
    }
  }
  return result;
}

export function isCustomThemeId(value: unknown): value is CustomThemeId {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function reject(reason: string): null {
  console.warn(`[CustomTheme] Rejected: ${reason}`);
  return null;
}

/**
 * Check an untrusted value and return a clean CustomTheme, or null
 * (with the reason logged) if it is anything but a well-formed theme.
 */
export function validateCustomTheme(value: unknown): CustomTheme | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return reject('not an object');
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return reject('not a plain object');
  }

  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== ALL_KEYS.length || !keys.every((key) => ALL_KEYS.includes(key))) {
    return reject('unexpected set of keys');
  }

  if (!isCustomThemeId(raw.id)) return reject('bad id');
  if (typeof raw.light !== 'boolean') return reject('light is not a boolean');

  if (typeof raw.name !== 'string' || raw.name.length > 500) return reject('bad name');
  const name = stripUnwantedChars(raw.name).trim();
  if (name.length < 1 || name.length > MAX_THEME_NAME_LENGTH) {
    return reject('name must be 1-30 characters');
  }

  const colors: Record<(typeof COLOR_KEYS)[number], string> = {
    bg: '', fg: '', muted: '', accent: '', solid: '', barFrom: '', barTo: '', barFg: '',
  };
  for (const key of COLOR_KEYS) {
    const color = raw[key];
    if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
      return reject(`${key} is not a #rrggbb colour`);
    }
    colors[key] = color.toLowerCase();
  }

  return { id: raw.id, name, light: raw.light, ...colors };
}
