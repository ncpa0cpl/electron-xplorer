import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Sidecar trash records.
 *
 * `shell.trashItem` gives no receipt, and the macOS/Windows trash
 * implementations do not record where a deleted item came from. After a
 * successful trash (src/main/fs-handlers.ts) we persist a record keyed by the
 * original path so the trash view can fill in `originalPath` and offer
 * "Restore" for those items. On Linux the authoritative `.trashinfo` metadata
 * is preferred; records only fill gaps.
 *
 * The file is loaded lazily, saved asynchronously and corruption is tolerated
 * (a broken file is treated as empty and replaced on the next save).
 */

/** Records older than this are pruned whenever the trash is listed. */
const RECORD_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const RECORDS_FILE = "trash-records.json";

/** Map keyed by the item's original (pre-trash) path → trashed-at epoch ms. */
type TrashRecordMap = Record<string, number>;

export interface TrashRecord {
  readonly originalPath: string;
  readonly trashedAt: number;
}

let cachedPath: string | undefined;

function recordsPath(): string {
  cachedPath ??= path.join(app.getPath("userData"), RECORDS_FILE);
  return cachedPath;
}

/** Reads the record map; any error (missing/corrupt file) yields `{}`. */
async function readMap(): Promise<TrashRecordMap> {
  try {
    const raw = await fs.readFile(recordsPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const map: TrashRecordMap = {};
    for (const [originalPath, trashedAt] of Object.entries(parsed)) {
      if (typeof trashedAt === "number" && Number.isFinite(trashedAt)) {
        map[originalPath] = trashedAt;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/** Best-effort async save; failures are silently ignored. */
async function writeMap(map: TrashRecordMap): Promise<void> {
  try {
    await fs.mkdir(path.dirname(recordsPath()), { recursive: true });
    await fs.writeFile(recordsPath(), JSON.stringify(map), "utf8");
  } catch {
    // Sidecar records are best-effort; losing one is not worth surfacing.
  }
}

/** Appends a record for a successfully trashed item. */
export async function recordTrashedItem(originalPath: string): Promise<void> {
  const map = await readMap();
  map[originalPath] = Date.now();
  await writeMap(map);
}

/**
 * Loads records, dropping stale ones: older than `RECORD_MAX_AGE_MS`, or
 * whose trashed item no longer exists under one of `liveNames` (i.e. the item
 * was restored or permanently deleted - the basename must still be present in
 * the trash that was listed). The pruned map is saved back asynchronously.
 */
export async function loadTrashRecords(
  liveNames: ReadonlySet<string>,
): Promise<TrashRecord[]> {
  const map = await readMap();
  const now = Date.now();
  const kept: TrashRecord[] = [];
  const next: TrashRecordMap = {};
  for (const [originalPath, trashedAt] of Object.entries(map)) {
    const stale = now - trashedAt > RECORD_MAX_AGE_MS
      || !liveNames.has(path.basename(originalPath));
    if (!stale) {
      kept.push({ originalPath, trashedAt });
      next[originalPath] = trashedAt;
    }
  }
  if (Object.keys(next).length !== Object.keys(map).length) {
    void writeMap(next);
  }
  return kept;
}

/**
 * Single-record lookup for restore flows (no pruning side effects): verifies
 * that the app itself trashed the item at `originalPath`.
 */
export async function peekTrashRecord(
  originalPath: string,
): Promise<TrashRecord | undefined> {
  const map = await readMap();
  const trashedAt = map[originalPath];
  return trashedAt === undefined
    ? undefined
    : { originalPath, trashedAt };
}

/**
 * Drops EVERY record: called after a successful "Empty Trash"
 * (fs:emptyTrash handler) — no trashed item exists anymore, so the ledger has
 * nothing left to describe. Best-effort, like every record write.
 */
export async function clearTrashRecords(): Promise<void> {
  await writeMap({});
}
