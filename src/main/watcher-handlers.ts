import { app, webContents } from "electron";
import fs from "node:fs";
import type { FSWatcher } from "node:fs";
import type { FsChangeEvent } from "../shared/watch-types";

/**
 * Filesystem watcher service.
 *
 * Keeps one NON-recursive `fs.watch(dir)` subscription per browsed directory.
 * Directories enter the registry via `noteDirectoryAccessed`, which the
 * `fs:readdirStat` handler calls for every directory the renderer browses or
 * refreshes, so the set of watched dirs naturally tracks what the user is
 * actually looking at. Never uses `{ recursive: true }` (watching `/` or
 * `$HOME` recursively would cause an inotify storm).
 *
 * Registry properties:
 *  - LRU-capped at MAX_WATCHED_DIRS; the least-recently-used watcher is
 *    closed when the cap is exceeded.
 *  - Events are debounced per directory (editors and write bursts fire many
 *    events) before being broadcast to the renderer.
 *  - Watcher errors (e.g. the directory was deleted) close and drop the
 *    watcher instead of crashing.
 *  - Watchers are non-persistent (`persistent: false`) and timers are
 *    unref'd, so they never keep the event loop alive; a `will-quit` hook
 *    closes everything on shutdown.
 */

const MAX_WATCHED_DIRS = 64;
const DEBOUNCE_MS = 200;

interface WatcherEntry {
  watcher: FSWatcher;
  /** Pending coalescing broadcast timer for this directory, if any. */
  timer: NodeJS.Timeout | null;
  /** Monotonic-ish recency stamp for LRU eviction. */
  lastUsed: number;
}

const watchers = new Map<string, WatcherEntry>();
let recencyCounter = 0;
let quitHookInstalled = false;

/** Registers the watcher service. Call once during app startup. */
export function registerWatcherHandlers(): void {
  if (quitHookInstalled) return;
  quitHookInstalled = true;

  // Clean shutdown: never let open watchers outlive the app.
  app.on("will-quit", () => {
    closeAllWatchers();
  });
}

/**
 * "Note directory accessed" hook. Called by the `fs:readdirStat` handler for
 * every directory the renderer lists, which both seeds new watchers and
 * refreshes LRU recency for existing ones. Never throws; directories that
 * cannot be watched are silently skipped.
 */
export function noteDirectoryAccessed(dir: string): void {
  const existing = watchers.get(dir);
  if (existing) {
    existing.lastUsed = ++recencyCounter;
    // Re-insert to keep Map iteration order = LRU order.
    watchers.delete(dir);
    watchers.set(dir, existing);
    return;
  }

  void tryWatch(dir);
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function tryWatch(dir: string): Promise<void> {
  try {
    // Degrade gracefully: skip anything that is not a watchable directory.
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) return;

    // Cap enforcement before creating a new watcher.
    while (watchers.size >= MAX_WATCHED_DIRS) {
      evictLeastRecentlyUsed();
    }

    // Non-recursive watch of exactly this directory. `persistent: false`
    // means the watcher never keeps the process alive on its own.
    const watcher = fs.watch(dir, { persistent: false }, () => {
      scheduleBroadcast(dir);
    });

    watcher.on("error", () => {
      // Directory deleted, permissions changed, EMFILE, ... — drop the
      // watcher and broadcast once so visible tabs can re-list (and fail
      // gracefully if the dir is gone).
      broadcast(dir);
      dropWatcher(dir);
    });
    watcher.on("close", () => {
      dropWatcher(dir);
    });

    watchers.set(dir, { watcher, timer: null, lastUsed: ++recencyCounter });
  } catch {
    // fs.watch unavailable (unsupported platform) or stat failed — skip.
  }
}

/** Coalesces an event burst for `dir` into a single broadcast. */
function scheduleBroadcast(dir: string): void {
  const entry = watchers.get(dir);
  if (!entry) return;

  entry.lastUsed = ++recencyCounter;

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

function evictLeastRecentlyUsed(): void {
  // Map preserves insertion order; the first entry is the least recently
  // touched (entries are re-inserted on access).
  const oldest = watchers.keys().next();
  if (oldest.done) return;
  dropWatcher(oldest.value);
}

function closeAllWatchers(): void {
  for (const dir of [...watchers.keys()]) {
    dropWatcher(dir);
  }
}
