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
 * - "Check for updates" (settings page, tray menu) triggers an
 *   interactive check, whose results show as app dialogs
 *
 * PLATFORM NOTES:
 * - Windows (NSIS) and Linux (AppImage) are supported
 * - macOS auto-update requires a signed build (Squirrel.Mac rejects
 *   unsigned updates), and the current mac builds are unsigned, so the
 *   updater is disabled there
 * - Disabled in development (no app-update.yml exists before packaging)
 */

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { toDisplayVersion } from '../shared/types';
import { showAppDialog } from './app-dialog';

const INITIAL_CHECK_DELAY_MS = 15 * 1000;
const RECURRING_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** True while a user-initiated check is in flight (show result dialogs). */
let interactiveCheck = false;

/** Prevent overlapping checks. */
let checkInProgress = false;

function isSupported(): boolean {
  return app.isPackaged && process.platform !== 'darwin';
}

/** e.g. "v3" */
function versionLabel(version: string): string {
  return 'v' + toDisplayVersion(version);
}

function runCheck(): void {
  if (checkInProgress) return;
  checkInProgress = true;

  autoUpdater.checkForUpdates().catch((error: unknown) => {
    console.error('[Updater] Check failed:', error);
    checkInProgress = false;
    if (interactiveCheck) {
      interactiveCheck = false;
      void showAppDialog({
        type: 'error',
        title: 'Couldn’t check for updates',
        message: 'Messenger Desktop couldn’t reach GitHub to look for a new version.',
        detail: error instanceof Error ? error.message : String(error),
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
      });
    }
  });
}

/**
 * Initialize the auto-updater and start the periodic check schedule.
 */
export function initializeAutoUpdater(): void {
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
      void showAppDialog({
        type: 'update',
        title: 'Update available',
        message: `Messenger Desktop ${versionLabel(info.version)} is downloading.`,
        detail: 'It downloads in the background. You’ll be asked to restart when it’s ready.',
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] No update available');
    checkInProgress = false;
    if (interactiveCheck) {
      interactiveCheck = false;
      void showAppDialog({
        type: 'success',
        title: 'You’re up to date',
        message: `Messenger Desktop ${versionLabel(app.getVersion())} is the latest version.`,
        detail: `Version ${app.getVersion()}`,
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update downloaded: ${info.version}`);
    checkInProgress = false;

    void showAppDialog({
      type: 'update',
      title: 'Update ready',
      message: `Messenger Desktop ${versionLabel(info.version)} is ready to install.`,
      detail: 'Restart now to finish, or it will install the next time you quit.',
      buttons: ['Later', 'Restart now'],
      defaultId: 1,
      cancelId: 0,
    }).then((response) => {
      if (response === 1) {
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
 * User-initiated update check (settings page, tray menu).
 * Shows result dialogs, unlike the silent background checks.
 */
export function checkForUpdatesInteractive(): void {
  if (!isSupported()) {
    void showAppDialog({
      type: 'info',
      title: 'Updates unavailable',
      message: !app.isPackaged
        ? 'Update checks only work in the installed app.'
        : 'Automatic updates aren’t available on macOS yet.',
      detail: app.isPackaged ? 'Download new versions from the project’s GitHub page.' : undefined,
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
    });
    return;
  }

  interactiveCheck = true;
  runCheck();
}
