import { ipcMain } from "electron";
import type { TrashRestoreItem } from "../shared/fs-types";
import { handle } from "./ipc";
import { getMainPlatform } from "./platform";
import { clearTrashRecords } from "./trash-records";

/**
 * Trash IPC handlers ("fs:*" channels).
 *
 *  - `fs:listTrash` returns the platform's trash listing (entries carry real
 *    absolute `trashPath`s, so the renderer maps them to FStats directly).
 *  - `fs:restoreTrash` takes an array of `{ trashPath, originalPath }`. The
 *    typed `handle` helper only validates path-string arguments, so this
 *    channel is registered with raw `ipcMain.handle` and the array is
 *    validated inline (same pattern as `system:setWindowTitle` in
 *    src/main/system-handlers.ts).
 *  - `fs:emptyTrash` takes no arguments and permanently deletes every trash
 *    item (the renderer confirms before invoking). After a successful empty
 *    the sidecar ledger is cleared too: no trashed item exists anymore, so
 *    its records could never be matched again.
 *
 * After a successful restore/empty no fs watcher fires for the virtual
 * `trash:///` location - the renderer refreshes itself.
 */

/** Registers all trash handlers. Call once during app startup. */
export function registerTrashHandlers(): void {
  handle("fs:listTrash", [], () => getMainPlatform().listTrash());
  ipcMain.handle(
    "fs:restoreTrash",
    (_event, items: unknown) =>
      getMainPlatform().restoreTrash(validateRestoreItems(items)),
  );
  handle("fs:emptyTrash", [], async () => {
    await getMainPlatform().emptyTrash();
    await clearTrashRecords();
  });
}

/**
 * Validates the restore request: a non-empty array of plain objects, each
 * carrying two non-empty absolute-path strings (trash path and original
 * location are both real native paths).
 */
function validateRestoreItems(arg: unknown): TrashRestoreItem[] {
  if (!Array.isArray(arg) || arg.length === 0) {
    throw new Error(
      "fs:restoreTrash: expected a non-empty array of restore items",
    );
  }
  return arg.map((raw, index): TrashRestoreItem => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`fs:restoreTrash: item #${index} must be an object`);
    }
    const { trashPath, originalPath } = raw as Record<string, unknown>;
    if (
      typeof trashPath !== "string"
      || trashPath.length === 0
      || typeof originalPath !== "string"
      || originalPath.length === 0
    ) {
      throw new Error(
        `fs:restoreTrash: item #${index} must have non-empty "trashPath" and "originalPath" strings`,
      );
    }
    const platform = getMainPlatform();
    if (
      !platform.isValidAbsolutePath(trashPath)
      || !platform.isValidAbsolutePath(originalPath)
    ) {
      throw new Error(
        `fs:restoreTrash: item #${index} paths must be absolute native paths`,
      );
    }
    return { trashPath, originalPath };
  });
}
