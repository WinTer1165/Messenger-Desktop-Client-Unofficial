/**
 * Auto-Update Module
 *
 * Uses electron-updater with the GitHub Releases feed configured in
 * electron-builder.yml (publish: github).
 *
 * Behavior:
 * - Checks for updates shortly after launch, then every 4 hours
 * - Downloads updates in the background
 * - When a download completes, asks the user to restart (or applies
 *   the update automatically on the next quit)
 * - "Check for Updates" in the tray menu triggers an interactive check
 *
 * PLATFORM NOTES:
 * - Windows (NSIS) and Linux (AppImage) are supported
 * - macOS auto-update requires a signed build (Squirrel.Mac rejects
 *   unsigned updates), and the current mac builds are unsigned, so the
 *   updater is disabled there
 * - Disabled in development (no app-update.yml exists before packaging)
 */

import { app, dialog, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

const INITIAL_CHECK_DELAY_MS = 15 * 1000;
const RECURRING_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let getMainWindow: (() => BrowserWindow | null) | null = null;

/** True while a user-initiated check is in flight (show result dialogs). */
let interactiveCheck = false;

/** Prevent overlapping checks. */
let checkInProgress = false;

function isSupported(): boolean {
  return app.isPackaged && process.platform !== 'darwin';
}

function parentWindow(): BrowserWindow | undefined {
  const win = getMainWindow?.();
  return win && !win.isDestroyed() ? win : undefined;
}

function runCheck(): void {
  if (checkInProgress) return;
  checkInProgress = true;

  autoUpdater.checkForUpdates().catch((error: unknown) => {
    console.error('[Updater] Check failed:', error);
    checkInProgress = false;
    if (interactiveCheck) {
      interactiveCheck = false;
      const win = parentWindow();
      if (win) {
        void dialog.showMessageBox(win, {
          type: 'error',
          title: 'Update Check Failed',
          message: 'Could not check for updates.',
          detail: error instanceof Error ? error.message : String(error),
          buttons: ['OK'],
        });
      }
    }
  });
}

/**
 * Initialize the auto-updater and start the periodic check schedule.
 *
 * @param mainWindowGetter - returns the current main window (used as
 *   the parent for dialogs)
 */
export function initializeAutoUpdater(
  mainWindowGetter: () => BrowserWindow | null
): void {
  getMainWindow = mainWindowGetter;

  if (!isSupported()) {
    console.log(
      `[Updater] Disabled (packaged: ${app.isPackaged}, platform: ${process.platform})`
    );
    return;
  }

  autoUpdater.autoDownload = true;
  // If the user picks "Later", the update still applies on next quit
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: ${info.version}`);
    if (interactiveCheck) {
      interactiveCheck = false;
      const win = parentWindow();
      if (win) {
        void dialog.showMessageBox(win, {
          type: 'info',
          title: 'Update Available',
          message: `Version ${info.version} is available.`,
          detail: 'It is being downloaded in the background. You will be asked to restart when it is ready.',
          buttons: ['OK'],
        });
      }
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] No update available');
    checkInProgress = false;
    if (interactiveCheck) {
      interactiveCheck = false;
      const win = parentWindow();
      if (win) {
        void dialog.showMessageBox(win, {
          type: 'info',
          title: 'No Updates',
          message: `You are up to date (version ${app.getVersion()}).`,
          buttons: ['OK'],
        });
      }
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update downloaded: ${info.version}`);
    checkInProgress = false;

    const win = parentWindow();
    const dialogPromise = win
      ? dialog.showMessageBox(win, {
          type: 'info',
          title: 'Update Ready',
          message: `Version ${info.version} has been downloaded.`,
          detail: 'Restart the app to apply the update now, or it will be applied automatically the next time you quit.',
          buttons: ['Restart Now', 'Later'],
          defaultId: 0,
          cancelId: 1,
        })
      : Promise.resolve({ response: 1 });

    void dialogPromise.then((result) => {
      if (result.response === 0) {
        // Bypass the minimize-to-tray close handler
        (app as unknown as { isQuitting?: boolean }).isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Error:', error);
    checkInProgress = false;
  });

  // Initial check shortly after launch, then periodically
  setTimeout(runCheck, INITIAL_CHECK_DELAY_MS);
  setInterval(runCheck, RECURRING_CHECK_INTERVAL_MS);

  console.log('[Updater] Initialized (GitHub Releases feed)');
}

/**
 * User-initiated update check (from the tray menu).
 * Shows result dialogs, unlike the silent background checks.
 */
export function checkForUpdatesInteractive(): void {
  if (!isSupported()) {
    const win = parentWindow();
    if (win) {
      const reason = !app.isPackaged
        ? 'Update checks are only available in the packaged app.'
        : 'Auto-update is not available on macOS builds. Please download updates from GitHub.';
      void dialog.showMessageBox(win, {
        type: 'info',
        title: 'Updates Unavailable',
        message: reason,
        buttons: ['OK'],
      });
    }
    return;
  }

  interactiveCheck = true;
  runCheck();
}
