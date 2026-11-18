/**
 * Themes for Messenger itself
 *
 * Carries the app's theme into Messenger's page, so the chat list, the
 * conversation and its menus match the title bar and the settings page
 * instead of staying Facebook-blue.
 *
 * HOW IT WORKS:
 * Messenger draws nearly all of its colours from CSS custom properties
 * (--surface-background, --primary-text, ...) that it defines twice,
 * once for its light mode and once for its dark mode. A theme
 *   1. switches Messenger to the mode matching the theme (light or
 *      dark), so everything not covered below is at least the right
 *      way round, and
 *   2. overrides the properties that carry the main surfaces, text and
 *      accent colours with the theme's own.
 *
 * Presentation only - no markup is touched, and no class names are
 * relied on apart from Messenger's two mode classes. If Messenger
 * renames a property, that part of the page falls back to its stock
 * colour. A colour theme chosen for one conversation inside Messenger
 * still wins there, because Messenger sets it closer to the messages.
 *
 * The login page is left alone: it has its own fixed colours.
 */

import { WebContents } from 'electron';
import * as settings from './settings';
import { findCustomTheme } from './custom-themes';

interface Palette {
  /** Whether this is a light theme (picks Messenger's mode) */
  light: boolean;
  /** Main surface */
  bg: string;
  /** Primary text and icons */
  fg: string;
  /** Secondary text and icons */
  muted: string;
  /** Buttons, links, your own message bubbles */
  accent: string;
  /**
   * Fill for things Messenger always writes on in white (your message
   * bubbles, primary buttons), where the accent is too bright for that
   */
  solid?: string;
}

/**
 * One palette per theme, based on the --page-* and --accent tokens in
 * renderer/titlebar.html - keep the two in step. Dark themes use a
 * brighter accent here than the title bar does, because in Messenger it
 * also colours links and icons that sit straight on the background.
 */
const PALETTES: Record<string, Palette> = {
  'dark': { light: false, bg: '#15171e', fg: '#f1f5f9', muted: '#94a3b8', accent: '#0866ff' },
  'light': { light: true, bg: '#ffffff', fg: '#0f172a', muted: '#475569', accent: '#0866ff' },
  'contrast': { light: false, bg: '#000000', fg: '#00ff41', muted: '#00c932', accent: '#00ff41', solid: '#0b6b22' },
  'lush-forest': { light: false, bg: '#052e24', fg: '#ecfdf5', muted: '#a7f3d0', accent: '#10b981', solid: '#047857' },
  'desert': { light: false, bg: '#2a1206', fg: '#fffbeb', muted: '#fdba74', accent: '#fb923c', solid: '#c2410c' },
  'electric': { light: false, bg: '#1c0b3a', fg: '#faf5ff', muted: '#c4b5fd', accent: '#a78bfa', solid: '#7c3aed' },
  'northern-lights': { light: false, bg: '#07141a', fg: '#eafff7', muted: '#7fd9c0', accent: '#2dd4bf', solid: '#0d9488' },
  'sakura-bloom': { light: true, bg: '#fff5fa', fg: '#500724', muted: '#9d4b73', accent: '#db2777' },
  'deep-ocean': { light: false, bg: '#04111f', fg: '#e0f2fe', muted: '#7dd3fc', accent: '#38bdf8', solid: '#0284c7' },
  'cosmic-nebula': { light: false, bg: '#10061d', fg: '#fdf4ff', muted: '#e9a8f5', accent: '#e879f9', solid: '#a21caf' },
  'sunset-drive': { light: false, bg: '#150f2e', fg: '#fff7ed', muted: '#fbb6ce', accent: '#f472b6', solid: '#db2777' },
  'arctic-frost': { light: true, bg: '#f4faff', fg: '#082f49', muted: '#3f6c8a', accent: '#0284c7' },
  'neon-city': { light: false, bg: '#07070d', fg: '#e0f7ff', muted: '#f0abfc', accent: '#f472b6', solid: '#db2777' },
};

/**
 * The palette for a theme id: a built-in theme, or a custom theme (the
 * one being previewed, or a saved one - see custom-themes.ts, which only
 * hands out validated themes, so every colour here is a plain #rrggbb).
 */
function resolvePalette(theme: string): Palette | null {
  if (Object.hasOwn(PALETTES, theme)) return PALETTES[theme];

  const custom = findCustomTheme(theme);
  if (!custom) return null;
  return {
    light: custom.light,
    bg: custom.bg,
    fg: custom.fg,
    muted: custom.muted,
    accent: custom.accent,
    solid: custom.solid,
  };
}

/** `amount`% of the text colour mixed into the surface: a lifted tone. */
function lift(palette: Palette, amount: number): string {
  return `color-mix(in srgb, ${palette.fg} ${String(amount)}%, ${palette.bg})`;
}

/** The text colour at `amount`% opacity: an overlay tone. */
function veil(palette: Palette, amount: number): string {
  return `color-mix(in srgb, ${palette.fg} ${String(amount)}%, transparent)`;
}

/**
 * Messenger's colour properties, mapped onto a palette. The property
 * names were read from messenger.com's own stylesheets.
 */
function getProperties(palette: Palette): Record<string, string> {
  const { bg, fg, muted, accent } = palette;
  const solid = palette.solid ?? accent;
  // The page behind the cards: a step away from the main surface
  const wash = palette.light
    ? lift(palette, 5)
    : `color-mix(in srgb, ${bg}, #000000 28%)`;
  const fade = (from: string): string =>
    `linear-gradient(to top, ${from}, color-mix(in srgb, ${from} 70%, transparent), transparent)`;

  return {
    // Surfaces
    'surface-background': bg,
    'card-background': bg,
    'card-background-flat': lift(palette, 4),
    'messenger-card-background': bg,
    'mwp-header-background-color': bg,
    'mwp-message-row-background': bg,
    'nav-bar-background': bg,
    'nav-bar-background-gradient': fade(bg),
    'nav-bar-background-gradient-wash': fade(wash),
    'web-wash': wash,
    'wash': lift(palette, 12),
    'messenger-reply-background': wash,
    'popover-background': lift(palette, 9),
    'overlay-alpha-80': `color-mix(in srgb, ${bg} 80%, transparent)`,
    'background-deemphasized': veil(palette, 9),
    'comment-background': lift(palette, 9),
    'comment-footer-background': lift(palette, 14),

    // Text and icons
    'primary-text': fg,
    'primary-icon': fg,
    'secondary-text': muted,
    'secondary-icon': muted,
    'placeholder-text': muted,
    'placeholder-icon': muted,
    'section-header-text': muted,
    'list-cell-chevron': muted,
    'text-input-outside-label': fg,
    'disabled-text': veil(palette, 32),
    'disabled-icon': veil(palette, 32),
    'disabled-button-text': veil(palette, 32),
    'disabled-button-background': veil(palette, 14),

    // Lines and states
    'divider': lift(palette, 15),
    'divider-on-color': lift(palette, 15),
    'border-focused': muted,
    'hover-overlay': veil(palette, 8),
    'press-overlay': veil(palette, 15),
    'scroll-thumb': veil(palette, 30),

    // Inputs
    'input-background': bg,
    'input-background-disabled': wash,
    'input-border-color': lift(palette, 15),
    'input-label-color-highlighted': accent,
    'text-input-bar-background': veil(palette, 9),

    // Buttons and accent
    'accent': accent,
    'primary-button-background': solid,
    'primary-deemphasized-button-background': `color-mix(in srgb, ${accent} 20%, transparent)`,
    'primary-deemphasized-button-pressed': `color-mix(in srgb, ${accent} 30%, transparent)`,
    'primary-deemphasized-button-text': accent,
    'secondary-button-background': veil(palette, 10),
    'secondary-button-background-floating': lift(palette, 14),
    'secondary-button-text': fg,
    'blue-link': accent,

    // Message bubbles
    'chat-outgoing-message-bubble-background-color': solid,
    'chat-incoming-message-bubble-background-color': lift(palette, 11),
    'chat-replied-message-background-color': veil(palette, 8),
    'chat-text-blockquote-color-background-line': veil(palette, 18),
  };
}

/**
 * The stylesheet for a theme, or '' for a theme without a palette.
 * Everything hangs off html.mdw-themed, which THEME_SCRIPT sets.
 */
export function getMessengerThemeCSS(theme: string): string {
  const palette = resolvePalette(theme);
  if (!palette) return '';

  const declarations = Object.entries(getProperties(palette))
    .map(([name, value]) => `  --${name}: ${value} !important;`)
    .join('\n');

  // Messenger defines its properties on the root and again on each
  // mode class, so the overrides are stated for all three
  return `
html.mdw-themed,
html.mdw-themed .__fb-light-mode,
html.mdw-themed .__fb-dark-mode {
  color-scheme: ${palette.light ? 'light' : 'dark'};
${declarations}
}
html.mdw-themed body {
  background-color: ${palette.bg} !important;
}
`;
}

/**
 * Switches Messenger between its light and dark mode by way of its own
 * mode classes, and marks the page as themed. Messenger's own choice is
 * remembered and put back when theming is turned off.
 */
const THEME_SCRIPT = `
  (function() {
    if (window.__mdwTheme) return;

    const DARK = '__fb-dark-mode';
    const LIGHT = '__fb-light-mode';
    const root = document.documentElement;

    let mode = null;      // 'dark', 'light', or null for Messenger's own
    let own = null;       // Messenger's own classes: { dark, light }

    function apply() {
      // The login page keeps its fixed colours
      const themed = mode !== null && !document.getElementById('login_form');
      root.classList.toggle('mdw-themed', themed);

      if (!themed) {
        if (own) {
          root.classList.toggle(DARK, own.dark);
          root.classList.toggle(LIGHT, own.light);
          own = null;
        }
        return;
      }

      const wantDark = mode === 'dark';
      const hasDark = root.classList.contains(DARK);
      const hasLight = root.classList.contains(LIGHT);
      if (hasDark === wantDark && hasLight === !wantDark) return;

      // Whatever is there now is Messenger's doing: either its choice
      // on load, or a change it made since
      own = { dark: hasDark, light: hasLight };
      root.classList.toggle(DARK, wantDark);
      root.classList.toggle(LIGHT, !wantDark);
    }

    // Messenger may set its mode class again (for instance when the
    // system switches between light and dark)
    new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['class'] });

    window.__mdwTheme = {
      set(newMode) {
        mode = newMode;
        apply();
      },
    };
  })();
`;

/** Stylesheet currently inserted into each page, so it can be replaced. */
const insertedCss = new WeakMap<WebContents, string>();

/**
 * Apply `theme` (a concrete theme, never 'auto') to a page showing
 * Messenger, or take the theme off again when the setting is off.
 *
 * @param freshPage - the page has just loaded, so nothing inserted
 *   earlier is left to remove
 */
export async function applyMessengerTheme(
  contents: WebContents,
  theme: string,
  freshPage = false
): Promise<void> {
  if (contents.isDestroyed()) return;

  const palette = settings.getThemeMessenger() ? resolvePalette(theme) : null;
  const css = palette ? getMessengerThemeCSS(theme) : '';
  const mode = palette ? (palette.light ? "'light'" : "'dark'") : 'null';

  try {
    const previous = insertedCss.get(contents);
    insertedCss.delete(contents);

    // The new colours go in before the old ones come out, so the page
    // never shows through in Messenger's own colours in between
    if (css !== '') {
      insertedCss.set(contents, await contents.insertCSS(css));
    }
    if (previous !== undefined && !freshPage) {
      await contents.removeInsertedCSS(previous);
    }

    await contents.executeJavaScript(THEME_SCRIPT);
    await contents.executeJavaScript(`window.__mdwTheme.set(${mode})`);
  } catch (error) {
    console.error('[Theme] Failed to theme Messenger:', error);
  }
}
