/**
 * Storage Housekeeping
 *
 * Keeps the Messenger session's V8 code cache from growing without end.
 *
 * WHY THIS MODULE EXISTS:
 * Electron gives the code cache no size limit of its own (it passes 0,
 * so Chromium sizes it from free disk space), and Messenger ships new
 * script bundles often, so compiled code for bundles that will never
 * load again piles up - about 500 MB was seen on a real install. The
 * `disk-cache-size` switch only caps the HTTP cache, not this one.
 *
 * The code cache is purely a speed-up that rebuilds itself, so it is
 * cleared once it passes a cap. Messages (IndexedDB) and the login
 * (cookies) are never touched.
 */

import { Session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** Clear the code cache once it grows past this. */
const CODE_CACHE_LIMIT_BYTES = 150 * 1024 * 1024;

/** First check waits for startup to settle, so it never slows launch. */
const FIRST_CHECK_DELAY_MS = 60 * 1000;

/** Then re-check daily, for apps left running for weeks. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let firstCheckTimer: NodeJS.Timeout | null = null;
let recurringCheckTimer: NodeJS.Timeout | null = null;

function toMB(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** Total size of the files under a directory, in bytes. */
async function directorySize(dir: string): Promise<number> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true, recursive: true });
  let total = 0;

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        try {
          // Await first: `total += await ...` would read `total` before
          // the await, and the parallel stats would overwrite each other
          const { size } = await fs.promises.stat(path.join(entry.parentPath, entry.name));
          total += size;
        } catch {
          // Chromium removed the entry mid-scan - nothing to count
        }
      })
  );

  return total;
}

async function trimCodeCache(ses: Session): Promise<void> {
  const storagePath = ses.getStoragePath();
  if (storagePath === null) return; // In-memory session

  const cacheDir = path.join(storagePath, 'Code Cache');

  let size: number;
  try {
    size = await directorySize(cacheDir);
  } catch {
    return; // No code cache yet
  }

  if (size <= CODE_CACHE_LIMIT_BYTES) {
    console.log(`[Storage] Code cache ${toMB(size)} MB (limit ${toMB(CODE_CACHE_LIMIT_BYTES)} MB)`);
    return;
  }

  await ses.clearCodeCaches({});
  const after = await directorySize(cacheDir).catch(() => 0);
  console.log(`[Storage] Code cache trimmed: ${toMB(size)} MB -> ${toMB(after)} MB`);
}

/**
 * Start checking the session's code cache size in the background.
 */
export function startStorageMaintenance(ses: Session): void {
  stopStorageMaintenance(); // Re-initialising (macOS) must not stack timers

  const run = (): void => {
    trimCodeCache(ses).catch((error: unknown) => {
      console.error('[Storage] Code cache check failed:', error);
    });
  };

  firstCheckTimer = setTimeout(run, FIRST_CHECK_DELAY_MS);
  recurringCheckTimer = setInterval(run, CHECK_INTERVAL_MS);
}

/** Stop the background checks (app quit). */
export function stopStorageMaintenance(): void {
  if (firstCheckTimer) {
    clearTimeout(firstCheckTimer);
    firstCheckTimer = null;
  }
  if (recurringCheckTimer) {
    clearInterval(recurringCheckTimer);
    recurringCheckTimer = null;
  }
}
