/**
 * Custom themes (main process)
 *
 * The user's own themes, made in the settings page from a single colour.
 * The title bar document generates the colour tokens; this module is the
 * only way they get stored or applied, and every one goes through
 * validateCustomTheme() first.
 *
 * Besides the saved themes there is at most one theme being PREVIEWED:
 * what the user is trying out in the editor. It is held in memory only,
 * applied to Messenger and the call windows like any theme, and dropped
 * when the editor is cancelled, the settings page closes or the app locks.
 */

import { CustomTheme, MAX_CUSTOM_THEMES } from '../shared/types';
import { isCustomThemeId, validateCustomTheme } from './custom-theme-validator';
import * as settings from './settings';

let preview: CustomTheme | null = null;

/** The theme being previewed, if any. */
export function getPreviewTheme(): CustomTheme | null {
  return preview;
}

/**
 * Preview a theme without saving it, or end the preview with null.
 * @returns false if the theme was rejected (the preview is left as it was)
 */
export function setPreviewTheme(value: unknown): boolean {
  if (value === null) {
    preview = null;
    return true;
  }
  const theme = validateCustomTheme(value);
  if (!theme) return false;
  preview = theme;
  return true;
}

/** A saved theme by id. */
export function findSavedTheme(id: string): CustomTheme | null {
  return settings.getCustomThemes().find((theme) => theme.id === id) ?? null;
}

/**
 * The theme an id stands for: the one being previewed if it has that id
 * (an edited theme is previewed under its own id), else the saved one.
 */
export function findCustomTheme(id: string): CustomTheme | null {
  if (preview?.id === id) return preview;
  return findSavedTheme(id);
}

/**
 * Save a theme: replaces the saved theme with the same id, or adds it.
 * Ends any preview.
 * @returns false if the theme was rejected or the limit is reached
 */
export function saveCustomTheme(value: unknown): boolean {
  const theme = validateCustomTheme(value);
  if (!theme) return false;

  const themes = settings.getCustomThemes();
  const index = themes.findIndex((other) => other.id === theme.id);
  if (index >= 0) {
    themes[index] = theme;
  } else if (themes.length >= MAX_CUSTOM_THEMES) {
    console.warn(`[CustomTheme] Rejected: already ${String(MAX_CUSTOM_THEMES)} saved themes`);
    return false;
  } else {
    themes.push(theme);
  }

  preview = null;
  settings.setCustomThemes(themes);
  return true;
}

/**
 * Delete a saved theme by id. Ends any preview.
 * @returns whether a theme was removed, and whether it was the one in use
 *   (the caller then switches to another theme)
 */
export function deleteCustomTheme(id: unknown): { removed: boolean; wasActive: boolean } {
  if (!isCustomThemeId(id)) {
    console.warn('[CustomTheme] Rejected: bad id for delete');
    return { removed: false, wasActive: false };
  }

  const themes = settings.getCustomThemes();
  if (!themes.some((theme) => theme.id === id)) return { removed: false, wasActive: false };

  const wasActive = settings.getTheme() === id;
  preview = null;
  settings.setCustomThemes(themes.filter((theme) => theme.id !== id));
  return { removed: true, wasActive };
}
