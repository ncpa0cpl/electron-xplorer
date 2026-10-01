import { app, ipcMain, webContents } from "electron";
import fs from "node:fs";
import type { FSWatcher } from "node:fs";
import type { FsChangeEvent } from "../shared/watch-types";

/**
 * Filesystem watcher service.
 *
 * Keeps one NON-recursive `fs.watch(dir)` subscription per directory that is
 * currently open in a renderer tab. The renderer declares WHICH dirs to watch
 * via the `watch:setDirs` IPC message (fired by fs-explorer's
 * `Filesystem.setWatchedDirs` whenever the set of open tab dirs changes; the
 * renderer adapter maps virtual trash locations to their real OS trash
 * storage dirs first). This service synchronizes its registry to that set:
 * watchers for dirs that fell out of the set are closed, watchers for newly
 * declared dirs are created. Never uses `{ recursive: true }` (watching `/`
 * or `$HOME` recursively would cause an inotify storm).
 *
 * Registry properties:
 *  - Capped at MAX_WATCHED_DIRS as a safety net; dirs beyond the cap are
 *    skipped (and retried on a later sync that still declares them).
 *  - Events are debounced per directory (editors and write bursts fire many
 *    events) before being broadcast to the renderer.
 *  - Watcher errors (e.g. the directory was deleted) close and drop the
 *    watcher instead of crashing; the dir is retried on the next sync.
 *  - Watchers are non-persistent (`persistent: false`) and timers are
 *    unref'd, so they never keep the event loop alive; a `will-quit` hook
 *    closes everything on shutdown.
 */

const MAX_WATCHED_DIRS = 256;
const DEBOUNCE_MS = 200;

interface WatcherEntry {
  watcher: FSWatcher;
  /** Pending coalescing broadcast timer for this directory, if any. */
  timer: NodeJS.Timeout | null;
}

const watchers = new Map<string, WatcherEntry>();
let quitHookInstalled = false;

/** Registers the watcher service. Call once during app startup. */
export function registerWatcherHandlers(): void {
  if (quitHookInstalled) return;
  quitHookInstalled = true;

  // Renderer-declared watched set. Registered with raw `ipcMain.on`
  // (fire-and-forget; the typed `handle` helper only validates path-string
  // arguments), with the payload validated inline below.
  ipcMain.on("watch:setDirs", (_event, dirs: unknown) => {
    setWatchedDirs(validateDirs(dirs));
  });

  // Clean shutdown: never let open watchers outlive the app.
  app.on("will-quit", () => {
    closeAllWatchers();
  });
}

/**
 * Synchronizes the watcher registry to the renderer-declared set: closes
 * watchers for dirs that are no longer declared, creates watchers for new
 * ones. Never throws; directories that cannot be watched are silently
 * skipped (and retried on the next sync that still declares them).
 */
export function setWatchedDirs(dirs: readonly string[]): void {
  const desired = new Set(dirs);

  for (const dir of [...watchers.keys()]) {
    if (!desired.has(dir)) {
      dropWatcher(dir);
    }
  }

  for (const dir of desired) {
    if (watchers.has(dir)) continue;
    if (watchers.size >= MAX_WATCHED_DIRS) {
      console.warn(
        `Watcher cap of ${MAX_WATCHED_DIRS} reached; not watching "${dir}".`,
      );
      continue;
    }
    void tryWatch(dir);
  }
}

/**
 * Validates the renderer-declared dir list: an array of non-empty strings
 * without null bytes. Invalid entries are dropped rather than rejecting the
 * whole sync — a stale watcher set is better than an exception mid-IPC.
 */
function validateDirs(arg: unknown): string[] {
  if (!Array.isArray(arg)) return [];
  return arg.filter(
    (d): d is string =>
      typeof d === "string" && d.length > 0
      && !d.includes("\0"),
  );
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function tryWatch(dir: string): Promise<void> {
  try {
    // Degrade gracefully: skip anything that is not a watchable directory.
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) return;

    // Non-recursive watch of exactly this directory. `persistent: false`
    // means the watcher never keeps the process alive on its own.
    const watcher = fs.watch(dir, { persistent: false }, () => {
      scheduleBroadcast(dir);
    });

    watcher.on("error", () => {
      // Directory deleted, permissions changed, EMFILE, ... — drop the
      // watcher and broadcast once so visible tabs can re-list (and fail
      // gracefully if the dir is gone). A later `setWatchedDirs` that still
      // declares the dir retries the watch.
      broadcast(dir);
      dropWatcher(dir);
    });
    watcher.on("close", () => {
      dropWatcher(dir);
    });

    watchers.set(dir, { watcher, timer: null });
  } catch {
    // fs.watch unavailable (unsupported platform) or stat failed — skip.
  }
}

/** Coalesces an event burst for `dir` into a single broadcast. */
function scheduleBroadcast(dir: string): void {
  const entry = watchers.get(dir);
  if (!entry) return;

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    broadcast(dir);
  }, DEBOUNCE_MS);
  entry.timer.unref?.();
}

/** Pushes one change event for `dir` to every live renderer. */
function broadcast(dir: string): void {
  const event: FsChangeEvent = { dirPath: dir };
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) {
      wc.send("fs:change", event);
    }
  }
}

function dropWatcher(dir: string): void {
  const entry = watchers.get(dir);
  if (!entry) return;
  watchers.delete(dir);
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  try {
    entry.watcher.close();
  } catch {
    // Already closed / errored.
  }
}

function closeAllWatchers(): void {
  for (const dir of [...watchers.keys()]) {
    dropWatcher(dir);
  }
}
