import { shell } from "electron";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DirEntry } from "../shared/fs-types";
import { handle } from "./ipc";
import { noteDirectoryAccessed } from "./watcher-handlers";

/**
 * Core filesystem IPC handlers ("fs:*" channels).
 */

/** Registers all fs handlers. Call once during app startup. */
export function registerFsHandlers(): void {
  handle("fs:readdirStat", ["path"], readdirStat);
  handle("fs:stat", ["path"], statEntry);
  handle("fs:exists", ["path"], exists);
  handle("fs:dirExists", ["path"], dirExists);
  handle("fs:copy", ["path", "path"], copy);
  handle("fs:move", ["path", "path"], move);
  handle("fs:remove", ["path"], remove);
  handle("fs:mkdir", ["path"], mkdir);
  handle("fs:touch", ["path"], touch);
  handle("fs:readFile", ["path"], readFile);
  handle("fs:trash", ["path"], trash);
}

/**
 * Batched directory listing: one IPC round trip returns every entry fully
 * stat'd, including real permission flags.
 *
 * Uses `readdir(..., { withFileTypes: true })` and a `Promise.allSettled` stat
 * pass. Symlinks are resolved via `stat` (following them) so e.g. symlinks to
 * directories are reported as directories; if `stat` fails (e.g. broken
 * symlink) we retry with `lstat` and, failing that, keep the entry with
 * dirent-derived info (type flags from the dirent, zero size/timestamps)
 * instead of silently dropping it.
 */
async function readdirStat(dir: string): Promise<DirEntry[]> {
  // Seed/refresh a watcher for every directory the renderer browses.
  noteDirectoryAccessed(dir);
  const dirents = await fs.readdir(dir, { withFileTypes: true });

  const settled = await Promise.allSettled(
    dirents.map(async (dirent): Promise<DirEntry> => {
      const full = path.join(dir, dirent.name);
      const st = await statBestEffort(full);
      const [readable, writable] = await Promise.all([
        canAccess(full, fs.constants.R_OK),
        canAccess(full, fs.constants.W_OK),
      ]);

      return {
        name: dirent.name,
        // Fall back to dirent-derived type info when stat is unavailable.
        isFile: st ? st.isFile() : dirent.isFile(),
        isDirectory: st ? st.isDirectory() : dirent.isDirectory(),
        isSymbolicLink: dirent.isSymbolicLink(),
        size: st?.size ?? 0,
        mtimeMs: st?.mtimeMs ?? 0,
        ctimeMs: st?.ctimeMs ?? 0,
        atimeMs: st?.atimeMs ?? 0,
        readable,
        writable,
      };
    }),
  );

  // Only drop an entry if even building its fallback representation failed,
  // which should be practically impossible; never fail the whole listing.
  return settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
}

/** `stat` for a single path, following symlinks. */
async function statEntry(p: string): Promise<DirEntry> {
  const st = await fs.stat(p);
  const [readable, writable] = await Promise.all([
    canAccess(p, fs.constants.R_OK),
    canAccess(p, fs.constants.W_OK),
  ]);

  return {
    name: path.basename(p),
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymbolicLink: st.isSymbolicLink(),
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    atimeMs: st.atimeMs,
    readable,
    writable,
  };
}

async function exists(p: string): Promise<boolean> {
  return canAccess(p, fs.constants.F_OK);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursive copy. Overwrites existing targets (`force: true`) - the fs-explorer
 * library checks for existing targets itself, prompts the user, and only calls
 * `copy` after the user confirms the overwrite, so the handler must overwrite.
 */
async function copy(from: string, to: string): Promise<void> {
  await fs.cp(from, to, { recursive: true, force: true, errorOnExist: false });
}

/**
 * Move via `rename`. `rename` silently overwrites existing targets on POSIX
 * (consistent with the lib's overwrite prompting). If it fails with `EXDEV`
 * (crossing filesystem boundaries), fall back to a recursive copy followed by
 * removal of the source.
 */
async function move(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "EXDEV") {
      await fs.cp(from, to, {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
      await fs.rm(from, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/** Permanent recursive delete. */
async function remove(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/** Creates a directory, creating missing parents as needed. */
async function mkdir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/**
 * Creates an empty file without truncating an existing one and without
 * erroring if the file already exists (the "a" flag positions at the end and
 * creates only if missing).
 */
async function touch(p: string): Promise<void> {
  const handle = await fs.open(p, "a");
  await handle.close();
}

/** Reads a whole file as bytes (serialized to the renderer as a Uint8Array). */
async function readFile(p: string): Promise<Uint8Array> {
  return await fs.readFile(p);
}

/** Moves a path to the OS trash. */
async function trash(p: string): Promise<void> {
  await shell.trashItem(p);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * `stat` with an `lstat` retry. Returns `undefined` when both fail so callers
 * can fall back to dirent info (broken symlinks etc.).
 */
async function statBestEffort(p: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(p);
  } catch {
    try {
      return await fs.lstat(p);
    } catch {
      return undefined;
    }
  }
}

async function canAccess(p: string, mode: number): Promise<boolean> {
  try {
    await fs.access(p, mode);
    return true;
  } catch {
    return false;
  }
}
