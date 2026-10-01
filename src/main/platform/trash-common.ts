import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadTrashRecords, type TrashRecord } from "../trash-records";

/**
 * Helpers shared by the per-platform trash implementations (see MainPlatform
 * listTrash/restoreTrash in src/main/platform/types.ts).
 *
 * Common restore semantics (FreeDesktop-style, applied to every platform):
 * missing parent directories are created, name collisions get a numeric
 * suffix (`name.2.ext`, `name.3.ext`, ...) so nothing is ever overwritten,
 * and cross-device renames fall back to a recursive copy + delete.
 *
 * Common empty semantics (`emptyTrash`): every trashed item is deleted
 * permanently and recursively, per-item best-effort — collected failures are
 * rejected as ONE aggregated error by the caller (see `restoreErrMessage`).
 */

/** `stat` with an `lstat` retry; `undefined` when the entry vanished. */
export async function statTrashEntry(p: string): Promise<Stats | undefined> {
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

/**
 * Sidecar records (src/main/trash-records.ts) keyed by the trashed item's
 * basename. Platforms whose OS trash does not record original locations
 * (macOS, and Windows entries without shell metadata) use this to fill in
 * `originalPath` for their listings.
 */
export async function trashRecordsByBasename(
  liveNames: ReadonlySet<string>,
): Promise<Map<string, TrashRecord>> {
  const records = await loadTrashRecords(liveNames);
  return new Map(
    records.map((record) => [path.basename(record.originalPath), record]),
  );
}

/** Message of an unknown error value (for aggregated restore errors). */
export function restoreErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Permanently removes every entry of `dir` (recursive; directories included).
 * Per-item best-effort: one unremovable entry does not block the rest —
 * failures are pushed onto `failures` as "<name>: <reason>" strings for the
 * caller to aggregate. A missing/unreadable `dir` yields nothing to do
 * (missing = already empty; used by the platform `emptyTrash` implementations
 * for e.g. the FreeDesktop `expunged/` dir, which the spec does not require
 * to exist).
 */
export async function removeDirEntries(
  dir: string,
  failures: string[],
): Promise<void> {
  const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(
    (): undefined => undefined,
  );
  if (!dirents) {
    return;
  }
  for (const dirent of dirents) {
    try {
      await fs.rm(path.join(dir, dirent.name), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      failures.push(`${dirent.name}: ${restoreErrMessage(err)}`);
    }
  }
}

/** Recursively removes the trashed item (force: it may already be gone). */
async function removeTrashed(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/**
 * Moves a trashed item back to `originalPath`. Throws when the move fails;
 * callers aggregate per-item failures into a user-facing error.
 */
export async function restoreToOriginalLocation(
  trashPath: string,
  originalPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  const target = await collisionFreeTarget(originalPath);

  try {
    await fs.rename(trashPath, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "EXDEV") {
      throw err;
    }
    // Cross-device (e.g. trash and home on different mounts): copy + delete.
    await fs.cp(trashPath, target, {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    await removeTrashed(trashPath);
  }
}

/**
 * Returns `originalPath` itself when free, otherwise the first free
 * `name.<n>.ext` candidate (deterministic, never overwrites).
 */
async function collisionFreeTarget(originalPath: string): Promise<string> {
  if (!(await exists(originalPath))) {
    return originalPath;
  }
  const ext = path.extname(originalPath);
  const base = ext ? originalPath.slice(0, -ext.length) : originalPath;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}.${n}${ext}`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`No free name found for "${originalPath}"`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
