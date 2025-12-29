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

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let debounceTimeout: NodeJS.Timeout | null = null;
let currentState: TrayState = {
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
 * In development, use the assets folder directly.
 * In production, use the packaged resources.
 */
function getIconPath(filename: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', filename);
  }
  return path.join(__dirname, '..', '..', 'assets', filename);
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
  const canvas = Buffer.alloc(size * size * 4); // RGBA

  // Fill with blue color (Messenger-ish)
  for (let i = 0; i < size * size; i++) {
    const offset = i * 4;
    canvas[offset] = 0;      // R
    canvas[offset + 1] = 132; // G
    canvas[offset + 2] = 255; // B (Messenger blue)
    canvas[offset + 3] = 255; // A
  }

  return nativeImage.createFromBuffer(canvas, {
    width: size,
    height: size,
    scaleFactor: 1.0,
  });
}

/**
 * Create an icon with unread badge overlay.
 * 
 * This is used on Windows where we can't easily update the tray icon.
 * On macOS, we use the dock badge instead.
 */
function createBadgeIcon(count: number): NativeImage {
  // For simplicity, we'll use text rendering in the main process
  // A more sophisticated approach would use canvas or a native module
  
  // If count is 0, return base icon
  if (count === 0) {
    return createBaseIcon();
  }

  // For now, return base icon - badge is shown via overlay on Windows
  // In a production app, you'd render the badge onto the icon
  return createBaseIcon();
}

/**
 * Create overlay icon for Windows taskbar.
 * Shows unread count as a small badge.
 */
function createOverlayIcon(count: number): NativeImage | null {
  if (count === 0) return null;

  // Create a small badge icon (16x16)
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  // Red background for badge
  for (let i = 0; i < size * size; i++) {
    const offset = i * 4;
    const x = i % size;
    const y = Math.floor(i / size);
    
    // Circle mask
    const centerX = size / 2;
    const centerY = size / 2;
    const radius = size / 2 - 1;
    const distance = Math.sqrt(
      Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2)
    );

    if (distance <= radius) {
      canvas[offset] = 255;     // R (red badge)
      canvas[offset + 1] = 59;  // G
      canvas[offset + 2] = 48;  // B
      canvas[offset + 3] = 255; // A (opaque)
    } else {
      canvas[offset + 3] = 0;   // A (transparent)
    }
  }

  return nativeImage.createFromBuffer(canvas, {
    width: size,
    height: size,
    scaleFactor: 1.0,
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

  // Update tray icon/tooltip
  if (tray) {
    tray.setToolTip(count > 0 ? `Messenger (${count} unread)` : 'Messenger');
    
    // On Windows/Linux, update the tray icon with badge
    if (process.platform !== 'darwin') {
      const badgeIcon = createBadgeIcon(count);
      tray.setImage(badgeIcon);
    }
  }

  // Platform-specific updates
  if (process.platform === 'darwin') {
    // macOS: Use dock badge
    app.dock?.setBadge(count > 0 ? (count > 99 ? '99+' : count.toString()) : '');
  } else if (process.platform === 'win32' && mainWindow) {
    // Windows: Use taskbar overlay
    const overlay = createOverlayIcon(count);
    mainWindow.setOverlayIcon(
      overlay,
      count > 0 ? `${count} unread messages` : ''
    );
  }

  // Flash taskbar if count increased and window not focused
  if (count > previousCount && mainWindow && !mainWindow.isFocused()) {
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
