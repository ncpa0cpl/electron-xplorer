import { type Filesystem, type FStat } from "@ncpa0cpl/fs-explorer";
import { lookup } from "mrmime";
import type { DirEntry, TrashEntryInfo } from "../shared/fs-types";
import type { Platform } from "../shared/platform/types";
import { generateCanvasThumbnail } from "./media-thumbs";
import { rendererPlatform } from "./platform";

/**
 * Implementation of fs-explorer's `Filesystem` interface on top of the
 * `window.xplorer` IPC bridge.
 *
 * Built per platform via `createFilesystem(platform)`: all path joins and
 * the hidden-file rule come from the shared `Platform`, so POSIX and win32
 * path shapes are produced consistently. Correctness note: main's
 * `fs:readdirStat` handler returns real Node paths only in the form of
 * (directory, entry-name) pairs - this adapter is the single place that
 * derives full entry paths, always via `platform.paths.join(dirpath, name)`,
 * so the string the renderer circulates is exactly what main's own
 * node:path-based handlers accept back on the next IPC call.
 *
 * Virtual trash location: the whole `trash:///` namespace is served here.
 * Every trash-derived FStat carries a VIRTUAL path (`trash:///<name>` for
 * items listed in the trash root, `trash:///<name>/<subpath>` for entries
 * browsed inside a trashed directory) plus the `trash` tag; the adapter
 * rewrites virtual paths to their REAL filesystem paths in flight, at the
 * IPC boundary of every Filesystem method (see `resolveTrashPath`). This
 * keeps main's path validation and handlers working on real paths while the
 * renderer circulates stable virtual ones.
 */

const xplorer = window.xplorer;

/** The virtual trash root path; also exported for other renderer modules. */
export const TRASH_ROOT = "trash:///";

function isTrashRoot(p: string): boolean {
  return p === TRASH_ROOT;
}

/**
 * True for any virtual trash path: the root itself or anything below it
 * (`trash:///<name>`, `trash:///<name>/<subpath>`).
 */
export function isTrashPath(p: string): boolean {
  return p === TRASH_ROOT || p.startsWith(TRASH_ROOT);
}

// ─── Virtual ↔ real trash path mapping ───────────────────────────────────────
//
// The authoritative mapping comes from the latest `fs:listTrash` result: the
// top-level item NAME is the anchor of the virtual namespace, mapped to its
// REAL absolute path (and origin info). Nested virtual paths resolve through
// their top-level anchor. The maps live at module scope so actions.ts can
// resolve paths too (the app creates exactly one Filesystem per session).

/** Latest trash listing, keyed by top-level item name. */
const trashEntriesByName = new Map<string, TrashEntryInfo>();

/** Real OS trash storage directories seen in listings (for the watcher). */
const trashStorageDirs = new Set<string>();

/** Segments of a virtual trash path after the root, empty segments dropped. */
function trashSegments(p: string): string[] {
  return p.slice(TRASH_ROOT.length).split("/").filter((s) => s.length > 0);
}

/**
 * Rewrites paths in flight: a virtual trash path becomes its real filesystem
 * path; anything else passes through unchanged. Top-level items resolve via
 * the latest trash listing; nested paths join the remaining segments onto
 * the real item path (with the PLATFORM separator, since the result must be
 * a real main-side path). Throws for stale virtual paths (item no longer in
 * the listing) — callers surface the error.
 */
export function resolveTrashPath(p: string): string {
  if (!isTrashPath(p) || isTrashRoot(p)) {
    return p;
  }
  const segs = trashSegments(p);
  const top = trashEntriesByName.get(segs[0]!);
  if (!top) {
    throw new Error(
      `"${
        segs[0]
      }" is not in the Trash anymore (refresh the view if it should be)`,
    );
  }
  return segs.length === 1
    ? top.trashPath
    : rendererPlatform().paths.join(top.trashPath, ...segs.slice(1));
}

/** Like `resolveTrashPath`, but null instead of throwing when unresolvable. */
function resolveTrashPathOrNull(p: string): string | null {
  try {
    return resolveTrashPath(p);
  } catch {
    return null;
  }
}

/** Virtual parent of a virtual trash path (the root for top-level items). */
function trashParent(virtual: string): string {
  const segs = trashSegments(virtual);
  if (segs.length <= 1) {
    return TRASH_ROOT;
  }
  return TRASH_ROOT + segs.slice(0, -1).join("/");
}

/**
 * Inverse mapping for the fs watcher: a REAL path inside OS trash storage →
 * the virtual path the tabs browsed (`TRASH_ROOT` for the storage dir
 * itself, `trash:///<name>/<rest>` below it; null when unrelated to trash).
 * No separator assumptions: the character right after the storage-dir prefix
 * is the platform separator, and the remainder is split on both.
 */
function trashVirtualFromReal(real: string): string | null {
  for (const dir of trashStorageDirs) {
    if (real === dir) {
      return TRASH_ROOT;
    }
    if (
      real.length > dir.length
      && real.startsWith(dir)
      && (real.charAt(dir.length) === "/" || real.charAt(dir.length) === "\\")
    ) {
      const segs = real.slice(dir.length + 1).split(/[\\/]/).filter((
        s,
      ) => s.length > 0);
      return segs.length === 0 ? TRASH_ROOT : TRASH_ROOT + segs.join("/");
    }
  }
  return null;
}

/** Strips trailing slashes from a non-root virtual directory path. */
function normalizeTrashDir(dirpath: string): string {
  return dirpath.replace(/\/+$/, "");
}

/** Synthesized stat for the virtual trash root (a read-only directory). */
function trashRootStat(): FStat {
  return {
    name: "trash",
    basedir: TRASH_ROOT,
    path: TRASH_ROOT,
    directory: true,
    hidden: false,
    size: 0,
    mtime: 0,
    read: true,
    // Writes into the trash are not supported (restore is the only way out).
    write: false,
  };
}

/**
 * Maps a trash listing entry to an FStat. The `path` is VIRTUAL
 * (`trash:///<name>`); the `trash` tag is the marker the renderer's actions
 * use for trash detection (never path-prefix checks). `originalPath` is null
 * when the original location is unknown.
 */
function trashEntryToFStat(entry: TrashEntryInfo): FStat {
  return {
    name: entry.name,
    basedir: TRASH_ROOT,
    path: TRASH_ROOT + entry.name,
    directory: entry.isDirectory,
    hidden: false,
    size: entry.size,
    mtime: entry.mtimeMs / 1000,
    read: true,
    // Exposed read-only: the lib hides its built-in Delete/Cut/Rename for
    // non-writable entries (trash items must leave via Restore/purge).
    write: false,
    mimetype: entry.isDirectory ? undefined : lookup(entry.name),
    trash: {
      originalPath: entry.originalPath,
      deletionTime: entry.deletionTime,
    },
  };
}

/**
 * Maps an entry listed INSIDE a trashed directory (real DirEntry listing of
 * the resolved real path) to an FStat with a virtual path under the trashed
 * item's virtual path. Nested entries cannot be restored individually
 * (restore the trashed parent), hence the null origin.
 */
function trashNestedEntryToFStat(virtualDir: string, entry: DirEntry): FStat {
  return {
    name: entry.name,
    basedir: virtualDir,
    path: `${virtualDir}/${entry.name}`,
    directory: entry.isDirectory,
    hidden: rendererPlatform().files.isHiddenName(entry.name),
    size: entry.size,
    mtime: entry.mtimeMs / 1000,
    ctime: entry.ctimeMs / 1000,
    atime: entry.atimeMs / 1000,
    read: entry.readable,
    // Read-only like all trash-derived entries (hides built-in
    // Delete/Cut/Rename; also truthful: writes are rejected by the adapter).
    write: false,
    mimetype: entry.isDirectory ? undefined : lookup(entry.name),
    trash: { originalPath: null, deletionTime: null },
  };
}

/** Builds the IPC-backed `Filesystem` for the given platform. */
export function createFilesystem(platform: Platform): Filesystem {
  /** Fetches the trash listing and refreshes the module-level path maps. */
  function listTrashEntries(): Promise<TrashEntryInfo[]> {
    return xplorer.listTrash().then((entries) => {
      trashEntriesByName.clear();
      trashStorageDirs.clear();
      for (const entry of entries) {
        trashEntriesByName.set(entry.name, entry);
        trashStorageDirs.add(platform.paths.dirname(entry.trashPath));
      }
      // The watched set may reference trash storage dirs that only became
      // known with this listing (e.g. a tab restored onto the trash root
      // declares its dirs before the first listing resolves) — re-push so
      // the storage dirs actually get watched.
      if (lastWatchedDirs.some((dir) => isTrashPath(dir))) {
        pushWatchedDirs();
      }
      return entries;
    });
  }

  /** Central dispatch: virtual trash paths vs plain real paths. */
  function readdirStatDispatch(dirpath: string): Promise<FStat[]> {
    if (isTrashRoot(dirpath)) {
      return listTrashEntries().then((entries) =>
        entries.map(trashEntryToFStat)
      );
    }
    if (isTrashPath(dirpath)) {
      const virtualDir = normalizeTrashDir(dirpath);
      const real = resolveTrashPath(dirpath);
      return xplorer.readdirStat(real).then((entries) =>
        entries.map((entry) => trashNestedEntryToFStat(virtualDir, entry))
      );
    }
    return xplorer.readdirStat(dirpath).then((entries) =>
      entries.map((entry) => entryToFStat(platform, dirpath, entry))
    );
  }

  return {
    readdir(p) {
      return readdirStatDispatch(p).then((entries) =>
        entries.map((e) => e.name)
      );
    },

    // Batched: a single IPC round trip fetches the dir listing with full stats,
    // real read/write flags and mime detection for every entry.
    readdirStat(dirpath) {
      return readdirStatDispatch(dirpath);
    },

    async stat(filepath) {
      if (isTrashRoot(filepath)) {
        return trashRootStat();
      }
      if (isTrashPath(filepath)) {
        const entry = await xplorer.stat(resolveTrashPath(filepath));
        const segs = trashSegments(filepath);
        const top = trashEntriesByName.get(segs[0]!);
        const parent = trashParent(filepath);
        return {
          name: entry.name,
          basedir: parent,
          // Exactly the string that was asked for (not a reconstruction).
          path: filepath,
          directory: entry.isDirectory,
          hidden: rendererPlatform().files.isHiddenName(entry.name),
          size: entry.size,
          mtime: entry.mtimeMs / 1000,
          ctime: entry.ctimeMs / 1000,
          atime: entry.atimeMs / 1000,
          read: entry.readable,
          write: false,
          mimetype: entry.isDirectory ? undefined : lookup(entry.name),
          // Top-level items keep their listing origin info; nested entries
          // cannot be restored individually (restore the trashed parent).
          trash: top && segs.length === 1
            ? { originalPath: top.originalPath, deletionTime: top.deletionTime }
            : { originalPath: null, deletionTime: null },
        };
      }
      const entry = await xplorer.stat(filepath);
      return entryToFStat(
        platform,
        platform.paths.dirname(filepath),
        entry,
      );
    },

    copy(from, to) {
      // Copying OUT of the trash is fine (it's effectively "restore by
      // copy"); copying INTO the trash is not a supported write.
      if (isTrashPath(to)) {
        return Promise.reject(
          new Error("Cannot copy files into the Trash."),
        );
      }
      return xplorer.copy(resolveTrashPath(from), to);
    },

    move(from, to) {
      if (isTrashPath(from)) {
        if (isTrashPath(to)) {
          // Rename / move within the trash: the target's final segment may
          // be a brand-new name (not in the listing), so anchor the rewrite
          // on the source's real location instead of the listing.
          const realFrom = resolveTrashPath(from);
          const toSegs = trashSegments(to);
          const realTo = toSegs.length === 1
              && !trashEntriesByName.has(toSegs[0]!)
            ? rendererPlatform().paths.join(
              rendererPlatform().paths.dirname(realFrom),
              toSegs[0]!,
            )
            : resolveTrashPath(to);
          return xplorer.move(realFrom, realTo);
        }
        // Moving OUT of the trash (cut-paste elsewhere).
        return xplorer.move(resolveTrashPath(from), to);
      }
      if (isTrashPath(to)) {
        return Promise.reject(
          new Error("Cannot move files into the Trash."),
        );
      }
      return xplorer.move(from, to);
    },

    // Product decision: "delete" moves files to the OS trash rather than
    // permanently removing them. The lib never calls `remove()` as part of its
    // overwrite flow (it only prompts, then expects copy/move to overwrite),
    // so trashing here is safe. In the trash itself, delete = purge: the item
    // is already trashed, so it is permanently removed instead.
    remove(p) {
      if (isTrashPath(p)) {
        return xplorer.removePermanent(resolveTrashPath(p));
      }
      return xplorer.trash(p);
    },

    mkdir(p) {
      if (isTrashPath(p)) {
        return Promise.reject(
          new Error("Cannot create directories inside the Trash."),
        );
      }
      return xplorer.mkdir(p);
    },

    touch(p) {
      if (isTrashPath(p)) {
        return Promise.reject(
          new Error("Cannot create files inside the Trash."),
        );
      }
      return xplorer.touch(p);
    },

    exists(p) {
      // The virtual trash root always "exists" (an empty trash still does).
      if (isTrashRoot(p)) {
        return Promise.resolve(true);
      }
      if (isTrashPath(p)) {
        const real = resolveTrashPathOrNull(p);
        return real === null
          ? Promise.resolve(false)
          : xplorer.exists(real);
      }
      return xplorer.exists(p);
    },

    dirExists(p) {
      if (isTrashRoot(p)) {
        return Promise.resolve(true);
      }
      if (isTrashPath(p)) {
        const real = resolveTrashPathOrNull(p);
        return real === null
          ? Promise.resolve(false)
          : xplorer.dirExists(real);
      }
      return xplorer.dirExists(p);
    },

    dirSize(dirpath) {
      if (isTrashRoot(dirpath)) {
        return listTrashEntries().then((entries) =>
          entries.reduce(
            (sum, entry) => entry.isDirectory ? sum : sum + entry.size,
            0,
          )
        );
      }
      return readdirStatDispatch(dirpath).then((entries) =>
        entries.reduce(
          (sum, entry) => entry.directory ? sum : sum + entry.size,
          0,
        )
      );
    },

    // ─── File-change watching ────────────────────────────────────────────────
    //
    // The lib declares WHICH dirs to watch via `setWatchedDirs` (the dirs
    // currently open in tabs, pushed on every tab open/close/navigation);
    // main keeps one non-recursive `fs.watch` per declared dir and pushes
    // `fs:change` events over IPC. The lib registers one global
    // `(dirPath?: string) => void` callback at startup (explorer.ts) and calls
    // `tab.refresh(dirPath)` on every tab; `dirPath` must equal the directory
    // path exactly as the tab browsed it — `history.findEntry` compares via
    // `Path.equals`, a normalized *segment-wise* comparison — so we forward
    // main's `dirPath` verbatim, EXCEPT for paths inside OS trash storage,
    // which are rewritten to the virtual path the tabs browsed. The callback
    // set and bridge subscription live at module scope below; the declared
    // dir set is translated to real paths there too.

    setWatchedDirs(dirs) {
      lastWatchedDirs = dirs;
      pushWatchedDirs();
    },

    onChange(callback) {
      ensureBridgeSubscription();
      changeCallbacks.add(callback);
    },

    offChange(callback) {
      changeCallbacks.delete(callback);
    },

    // ─── Thumbnails (disk-cached, streaming URLs) ────────────────────────────
    //
    // Main process first: a small PNG generated by nativeImage and persisted in
    // `userData/thumbnails` (served back as an `xmedia://` URL). On a miss the
    // renderer generates the thumbnail with a canvas (videos, GIF/WebP/AVIF/SVG)
    // and pushes it to the main process's disk cache via `media:cacheThumbnail`,
    // so it is generated only once per file version.

    async thumbnail(p) {
      // The virtual trash root is not a file; virtual item paths are
      // rewritten to their real paths below.
      if (isTrashRoot(p)) {
        return null;
      }
      const real = resolveTrashPathOrNull(p) ?? p;
      try {
        const cached = await xplorer.getThumbnail(real);
        if (cached) return cached;

        const dataUrl = await generateCanvasThumbnail(real);
        if (!dataUrl) return null;
        const persisted = await xplorer.cacheThumbnail(real, dataUrl).catch(
          () => "",
        );
        return persisted || dataUrl;
      } catch {
        return null;
      }
    },
  };
}

// ─── File-change watching plumbing ───────────────────────────────────────────

const changeCallbacks = new Set<(dirPath?: string) => void>();

/** Last watched set declared by the lib (virtual trash paths included). */
let lastWatchedDirs: readonly string[] = [];

/**
 * Forwards the lib-declared watched set to main over IPC. Virtual trash
 * paths must be translated to real dirs first: a tab on the trash root
 * watches every known OS trash storage dir, a tab inside a trashed item
 * watches the real dir it browsed. Real paths pass through unchanged — they
 * are exactly the strings tabs browsed, so main's change events (forwarded
 * verbatim below) match tab history entries segment-wise.
 */
function pushWatchedDirs(): void {
  const realDirs = new Set<string>();
  for (const dir of lastWatchedDirs) {
    if (isTrashRoot(dir)) {
      for (const storageDir of trashStorageDirs) {
        realDirs.add(storageDir);
      }
    } else if (isTrashPath(dir)) {
      const real = resolveTrashPathOrNull(dir);
      if (real !== null) {
        realDirs.add(real);
      }
    } else {
      realDirs.add(dir);
    }
  }
  xplorer.setWatchedDirs([...realDirs]);
}

// Single bridge subscription, created lazily on first onChange registration;
// it lives for the page lifetime (the lib itself registers one callback for
// the Explorer's lifetime and unsubscribes on Explorer destroy).
let bridgeSubscribed = false;
function ensureBridgeSubscription(): void {
  if (bridgeSubscribed) return;
  bridgeSubscribed = true;
  xplorer.onFsChange((event) => {
    // Watched trash storage dirs report REAL paths; tabs browsed the virtual
    // ones — rewrite before forwarding (null = not trash-related).
    const dirPath = event.dirPath === undefined
      ? undefined
      : trashVirtualFromReal(event.dirPath) ?? event.dirPath;
    // Copy so callbacks may unsubscribe during iteration; a throwing
    // callback must not break the others.
    for (const cb of [...changeCallbacks]) {
      try {
        cb(dirPath);
      } catch {
        // Ignore listener errors.
      }
    }
  });
}

function entryToFStat(
  platform: Platform,
  dirpath: string,
  entry: DirEntry,
): FStat {
  return {
    basedir: dirpath,
    directory: entry.isDirectory,
    name: entry.name,
    // Platform-specific hiding convention: leading dot on POSIX, the
    // documented name-based approximation on win32.
    hidden: platform.files.isHiddenName(entry.name),
    path: platform.paths.join(dirpath, entry.name),
    read: entry.readable,
    write: entry.writable,
    size: entry.size,
    mtime: entry.mtimeMs / 1000,
    ctime: entry.ctimeMs / 1000,
    atime: entry.atimeMs / 1000,
    mimetype: entry.isDirectory ? undefined : lookup(entry.name),
  };
}
