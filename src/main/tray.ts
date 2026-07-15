/**
 * System Tray Module
 * 
 * Handles:
 * - Tray icon creation and management
 * - Unread badge/overlay rendering (platform-specific)
 * - Tray context menu
 * - Click-to-show/hide behavior
 * 
 * PLATFORM CONSIDERATIONS:
 * 
 * Windows:
 * - Overlay icons on taskbar (setOverlayIcon)
 * - Tray icon badge requires custom rendering
 * - Flash frame for attention (flashFrame)
 * 
 * macOS:
 * - Dock badge (app.dock.setBadge)
 * - Native tray icon with template support
 * - Bounce dock icon for attention
 * 
 * Linux:
 * - AppIndicator support varies by DE
 * - Unity/GNOME have different APIs
 * - Fallback to basic tray icon
 * 
 * DEBOUNCING:
 * Tray updates are debounced to prevent excessive redraws when
 * multiple unread count updates arrive in quick succession.
 * This is important because badge rendering can be expensive.
 */

import {
  app,
  Tray,
  Menu,
  nativeImage,
  NativeImage,
  BrowserWindow,
} from 'electron';
import * as path from 'path';
import { TRAY_UPDATE_DEBOUNCE_MS, TrayState } from '../shared/types';
import * as settings from './settings';
import { checkForUpdatesInteractive } from './updater';

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let debounceTimeout: NodeJS.Timeout | null = null;
const currentState: TrayState = {
  unreadCount: 0,
  lastUpdate: 0,
};

// Base tray icon (cached)
let baseIcon: NativeImage | null = null;

// ═══════════════════════════════════════════════════════════════════
// ICON GENERATION
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the path to tray icon assets.
 *
 * The assets folder is packaged inside the asar (electron-builder
 * `files`), and __dirname-relative paths resolve into the asar, so the
 * same path works in development and production.
 * (process.resourcesPath/assets does NOT exist in packaged builds -
 * only dist/preload is copied as extraResources.)
 */
function getIconPath(filename: string): string {
  return path.join(__dirname, '..', '..', 'assets', filename);
}

/**
 * Write one pixel into a raw bitmap buffer.
 *
 * Electron's nativeImage.createFromBuffer interprets raw data as
 * BGRA with premultiplied alpha - writing plain RGBA silently swaps
 * red/blue (a blue fill renders orange).
 */
function setPixel(
  canvas: Buffer,
  offset: number,
  r: number,
  g: number,
  b: number,
  a: number
): void {
  canvas[offset] = Math.round((b * a) / 255);
  canvas[offset + 1] = Math.round((g * a) / 255);
  canvas[offset + 2] = Math.round((r * a) / 255);
  canvas[offset + 3] = a;
}

/**
 * Create the base tray icon.
 * Uses template image on macOS for menu bar compatibility.
 */
function createBaseIcon(): NativeImage {
  if (baseIcon) return baseIcon;

  const iconName = process.platform === 'darwin' 
    ? 'tray-iconTemplate.png'  // macOS template (black, system colors it)
    : 'tray-icon.png';         // Windows/Linux (colored)

  try {
    baseIcon = nativeImage.createFromPath(getIconPath(iconName));
    
    // Fallback to a generated icon if file doesn't exist
    if (baseIcon.isEmpty()) {
      console.warn('[Tray] Icon file not found, using generated icon');
      baseIcon = createGeneratedIcon();
    }
  } catch {
    console.warn('[Tray] Failed to load icon, using generated icon');
    baseIcon = createGeneratedIcon();
  }

  return baseIcon;
}

/**
 * Generate a simple icon programmatically.
 * Used as fallback when icon files are missing.
 */
function createGeneratedIcon(): NativeImage {
  // Create a simple 16x16 icon
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  // Rounded blue disc (Messenger-ish) instead of a hard square
  const center = size / 2;
  const radius = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.sqrt(
        Math.pow(x + 0.5 - center, 2) + Math.pow(y + 0.5 - center, 2)
      );
      const coverage = Math.max(0, Math.min(1, radius - distance + 0.5));
      if (coverage > 0) {
        setPixel(canvas, (y * size + x) * 4, 0, 132, 255, Math.round(coverage * 255));
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, {
    width: size,
    height: size,
    scaleFactor: 1.0,
  });
}

/**
 * 3x5 pixel font for badge digits.
 * Each glyph is 5 rows of 3 bits (MSB = left pixel).
 */
const BADGE_FONT: Record<string, number[] | undefined> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b010, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
};

/**
 * Create overlay icon for the Windows taskbar: a red circle with the
 * actual unread count rendered in white pixels ("99+" beyond 99).
 *
 * Rendered at 32x32 with scaleFactor 2 so it displays as a crisp
 * 16 DIP badge on high-DPI screens.
 */
function createOverlayIcon(count: number): NativeImage | null {
  if (count === 0) return null;

  const size = 32;
  const canvas = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = size / 2 - 0.5;

  // Red circle with anti-aliased edge
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.sqrt(
        Math.pow(x + 0.5 - center, 2) + Math.pow(y + 0.5 - center, 2)
      );
      // 0..1 coverage for a smooth edge
      const coverage = Math.max(0, Math.min(1, radius - distance + 0.5));
      if (coverage > 0) {
        setPixel(canvas, (y * size + x) * 4, 255, 59, 48, Math.round(coverage * 255));
      }
    }
  }

  // Render the count text with the 3x5 pixel font
  const text = count > 99 ? '99+' : String(count);
  // Pixel scale chosen so the text fits inside the circle
  const scale = text.length === 1 ? 4 : text.length === 2 ? 3 : 2;
  const gap = scale; // space between characters (in canvas px)
  const textWidth = text.length * 3 * scale + (text.length - 1) * gap;
  const textHeight = 5 * scale;
  const startX = Math.round((size - textWidth) / 2);
  const startY = Math.round((size - textHeight) / 2);

  for (let i = 0; i < text.length; i++) {
    const glyph = BADGE_FONT[text[i]];
    if (!glyph) continue;
    const glyphX = startX + i * (3 * scale + gap);

    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if ((glyph[row] >> (2 - col)) & 1) {
          // Fill a scale x scale block of white pixels
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = glyphX + col * scale + dx;
              const py = startY + row * scale + dy;
              if (px >= 0 && px < size && py >= 0 && py < size) {
                setPixel(canvas, (py * size + px) * 4, 255, 255, 255, 255);
              }
            }
          }
        }
      }
    }
  }

  return nativeImage.createFromBuffer(canvas, {
    width: size,
    height: size,
    scaleFactor: 2.0,
  });
}

// ═══════════════════════════════════════════════════════════════════
// TRAY CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════

/**
 * Create the tray context menu.
 */
function createContextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Show Messenger',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: 'Do Not Disturb',
      type: 'checkbox',
      checked: settings.getDoNotDisturb(),
      click: (menuItem) => {
        settings.setDoNotDisturb(menuItem.checked);
        console.log(
          `[Tray] Do Not Disturb: ${menuItem.checked ? 'ENABLED' : 'DISABLED'}`
        );
      },
    },
    {
      label: 'Start with System',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({
          openAtLogin: menuItem.checked,
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Check for Updates…',
      click: () => checkForUpdatesInteractive(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);
}

// ═══════════════════════════════════════════════════════════════════
// WINDOW MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * Show the main window.
 */
function showWindow(): void {
  if (!mainWindow) return;

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

/**
 * Toggle window visibility.
 */
function toggleWindow(): void {
  if (!mainWindow) return;

  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════

/**
 * Initialize the system tray.
 * 
 * @param window - The main BrowserWindow instance
 */
export function initializeTray(window: BrowserWindow): void {
  mainWindow = window;

  // Create tray icon
  const icon = createBaseIcon();
  tray = new Tray(icon);

  // Set up tray
  tray.setToolTip('Messenger');
  tray.setContextMenu(createContextMenu());

  // Click behavior (platform-specific)
  if (process.platform === 'darwin') {
    // macOS: single click toggles
    tray.on('click', () => toggleWindow());
  } else {
    // Windows/Linux: single click shows, right-click for menu
    tray.on('click', () => showWindow());
  }

  // Double-click always shows (Windows/Linux)
  tray.on('double-click', () => showWindow());

  console.log('[Tray] Initialized');
}

/**
 * Update the unread count badge.
 * Debounced and idempotent - safe to call frequently.
 * 
 * @param count - New unread count
 */
export function updateUnreadCount(count: number): void {
  // Validate input
  if (!Number.isInteger(count) || count < 0) {
    console.warn('[Tray] Invalid unread count:', count);
    return;
  }

  // Idempotency check - skip if count hasn't changed
  if (count === currentState.unreadCount) {
    return;
  }

  // Clear existing debounce timeout
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
  }

  // Debounce the update
  debounceTimeout = setTimeout(() => {
    performUnreadUpdate(count);
  }, TRAY_UPDATE_DEBOUNCE_MS);
}

/**
 * Perform the actual unread count update.
 * Called after debounce delay.
 */
function performUnreadUpdate(count: number): void {
  const previousCount = currentState.unreadCount;
  currentState.unreadCount = count;
  currentState.lastUpdate = Date.now();

  console.log(`[Tray] Unread count: ${previousCount} -> ${count}`);

  // Update tray tooltip
  if (tray) {
    tray.setToolTip(count > 0 ? `Messenger (${count} unread)` : 'Messenger');
  }

  // Platform-specific updates
  if (process.platform === 'darwin') {
    // macOS: Use dock badge
    app.dock?.setBadge(count > 0 ? (count > 99 ? '99+' : count.toString()) : '');
  } else if (process.platform === 'win32' && mainWindow) {
    // Windows: Numeric badge rendered onto the taskbar overlay
    const overlay = createOverlayIcon(count);
    mainWindow.setOverlayIcon(
      overlay,
      count > 0 ? `${count} unread messages` : ''
    );
  }

  // Flash taskbar if count increased and window not focused
  // (suppressed while Do Not Disturb is on)
  if (
    count > previousCount &&
    mainWindow &&
    !mainWindow.isFocused() &&
    !settings.getDoNotDisturb()
  ) {
    flashWindow();
  }
}

/**
 * Flash the taskbar/dock to get user attention.
 * Called when new messages arrive and window is not focused.
 */
export function flashWindow(): void {
  if (!mainWindow) return;

  if (process.platform === 'darwin') {
    // macOS: Bounce dock icon
    app.dock?.bounce('informational');
  } else {
    // Windows/Linux: Flash taskbar
    mainWindow.flashFrame(true);
  }
}

/**
 * Stop flashing the taskbar/dock.
 * Called when window gains focus.
 */
export function stopFlashing(): void {
  if (!mainWindow) return;

  if (process.platform !== 'darwin') {
    mainWindow.flashFrame(false);
  }
}

/**
 * Clean up tray resources.
 * Call on app quit.
 */
export function destroyTray(): void {
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
    debounceTimeout = null;
  }

  if (tray) {
    tray.destroy();
    tray = null;
  }

  mainWindow = null;
  baseIcon = null;

  console.log('[Tray] Destroyed');
}

/**
 * Get current tray state (for debugging).
 */
export function getTrayState(): TrayState {
  return { ...currentState };
}
