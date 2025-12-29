/**
 * Window Manager Module
 * 
 * Handles:
 * - Window state persistence (position, size, maximized state)
 * - Window bounds validation (ensure window is visible on screen)
 * - Debounced state saving to prevent excessive disk writes
 * 
 * ARCHITECTURE NOTE:
 * Window state is persisted to disk using electron-store.
 * This allows the app to remember its position/size across restarts.
 * State is saved with debouncing to avoid excessive writes during resize.
 */

import { screen, BrowserWindow, Rectangle } from 'electron';
import Store from 'electron-store';
import {
  WindowState,
  DEFAULT_WINDOW_STATE,
  WINDOW_STATE_SAVE_DEBOUNCE_MS,
} from '../shared/types';

// ═══════════════════════════════════════════════════════════════════
// STORE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

interface StoreSchema {
  windowState: WindowState;
}

const store = new Store<StoreSchema>({
  name: 'window-state',
  defaults: {
    windowState: DEFAULT_WINDOW_STATE,
  },
  // Encrypt sensitive data (not critical for window state, but good practice)
  encryptionKey: 'messenger-wrapper-v1',
});

// Type-safe store access functions
function getStoredWindowState(): WindowState {
  return (store as unknown as { get(key: 'windowState'): WindowState }).get('windowState');
}

function setStoredWindowState(state: WindowState): void {
  (store as unknown as { set(key: 'windowState', value: WindowState): void }).set('windowState', state);
}

// ═══════════════════════════════════════════════════════════════════
// WINDOW STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * Debounce timer reference for state saving.
 */
let saveStateTimeout: NodeJS.Timeout | null = null;

/**
 * Check if a rectangle is visible on any display.
 * Returns true if at least 100x100 pixels are visible.
 */
function isVisibleOnAnyDisplay(bounds: Rectangle): boolean {
  const displays = screen.getAllDisplays();
  const minVisibleArea = 100 * 100; // Minimum 100x100 pixels visible

  for (const display of displays) {
    const intersection = getIntersection(bounds, display.workArea);
    if (intersection) {
      const area = intersection.width * intersection.height;
      if (area >= minVisibleArea) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get the intersection of two rectangles.
 * Returns null if no intersection.
 */
function getIntersection(a: Rectangle, b: Rectangle): Rectangle | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;

  if (width > 0 && height > 0) {
    return { x, y, width, height };
  }

  return null;
}

/**
 * Get window state, ensuring bounds are valid for current display configuration.
 * 
 * This handles the case where:
 * - User disconnects an external monitor
 * - Display resolution changes
 * - Window was positioned off-screen
 */
export function getWindowState(): WindowState {
  const savedState = getStoredWindowState();

  // If we have saved position, validate it's visible
  if (savedState.x !== undefined && savedState.y !== undefined) {
    const bounds: Rectangle = {
      x: savedState.x,
      y: savedState.y,
      width: savedState.width,
      height: savedState.height,
    };

    if (isVisibleOnAnyDisplay(bounds)) {
      return savedState;
    }

    // Window would be off-screen, reset position but keep size
    console.log('[WindowManager] Saved position off-screen, centering window');
    return {
      ...savedState,
      x: undefined,
      y: undefined,
    };
  }

  return savedState;
}

/**
 * Save window state with debouncing.
 * Called on window move/resize events.
 */
export function saveWindowState(window: BrowserWindow): void {
  // Clear existing timeout
  if (saveStateTimeout) {
    clearTimeout(saveStateTimeout);
  }

  // Debounce the save
  saveStateTimeout = setTimeout(() => {
    if (window.isDestroyed()) return;

    const bounds = window.getBounds();
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: window.isMaximized(),
      isFullScreen: window.isFullScreen(),
    };

    setStoredWindowState(state);
    console.log('[WindowManager] State saved:', state);
  }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
}

/**
 * Attach window state listeners to a BrowserWindow.
 * Call this after creating the window.
 */
export function attachWindowStateListeners(window: BrowserWindow): void {
  // Save state on resize (debounced)
  window.on('resize', () => {
    if (!window.isMaximized() && !window.isFullScreen()) {
      saveWindowState(window);
    }
  });

  // Save state on move (debounced)
  window.on('move', () => {
    if (!window.isMaximized() && !window.isFullScreen()) {
      saveWindowState(window);
    }
  });

  // Save maximized/fullscreen state immediately
  window.on('maximize', () => saveWindowState(window));
  window.on('unmaximize', () => saveWindowState(window));
  window.on('enter-full-screen', () => saveWindowState(window));
  window.on('leave-full-screen', () => saveWindowState(window));

  // Clear timeout on close
  window.on('close', () => {
    if (saveStateTimeout) {
      clearTimeout(saveStateTimeout);
      saveStateTimeout = null;
    }
    // Final save before close
    saveWindowState(window);
  });
}

/**
 * Apply saved window state (restore maximized/fullscreen).
 * Call this after window is ready-to-show.
 */
export function restoreWindowState(window: BrowserWindow): void {
  const state = getStoredWindowState();

  if (state.isMaximized) {
    window.maximize();
  }

  if (state.isFullScreen) {
    window.setFullScreen(true);
  }
}

/**
 * Reset window state to defaults.
 * Useful for troubleshooting window positioning issues.
 */
export function resetWindowState(): void {
  setStoredWindowState(DEFAULT_WINDOW_STATE);
  console.log('[WindowManager] State reset to defaults');
}
