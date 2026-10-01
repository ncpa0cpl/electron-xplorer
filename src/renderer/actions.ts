import type {
  Explorer,
  ExplorerAction,
  ExplorerOptions,
  FileAction,
  FStat,
} from "@ncpa0cpl/fs-explorer";
import { Path } from "@ncpa0cpl/fs-explorer";
import { createElement } from "@ncpa0cpl/vanilla-jsx";
import type { ReadonlySignal } from "@ncpa0cpl/vanilla-jsx/signals";
import { sig } from "@ncpa0cpl/vanilla-jsx/signals";
import { resolveTrashPath, TRASH_ROOT } from "./fs-adapter";
import { rendererPlatform } from "./platform";

/**
 * Shell integration for the explorer: system-default file opening, custom
 * context-menu actions ("Open With…", "Open in Terminal", "Delete
 * Permanently", "Restore" + "Empty Trash" for the trash), OS drag-in support
 * and window title synchronization.
 *
 * Custom action error feedback uses `explorer.overlay.display` with a small
 * dismissible box (the lib's `actionError` signal is dispatched internally but
 * never rendered by any lib component, so it cannot be reused here).
 */

/** The live explorer instance; set once during bootstrap by `registerExplorer`. */
let explorerRef: Explorer | undefined;

// ─── Trash detection ─────────────────────────────────────────────────────────

/**
 * True for trash-derived entries: items listed in the virtual trash root and
 * items browsed inside OS trash storage (e.g. within a trashed directory).
 *
 * The fs adapter tags ALL trash-derived FStats with the `trash` field
 * (`originalPath` null when unknown) — this is the ONLY reliable detection.
 * Trash item paths are REAL filesystem paths (e.g.
 * `/home/u/.local/share/Trash/files/foo`), so `Path.isInside(TRASH_ROOT)`
 * never matches them, and `basedir === TRASH_ROOT` only covers the top level.
 */
function isTrashItem(file: FStat): boolean {
  return file.trash != null;
}

/** Trash detection that also covers the virtual trash root itself. */
function isTrashLocation(file: FStat): boolean {
  return file.path === TRASH_ROOT || isTrashItem(file);
}

/** Registers the explorer instance and starts window title synchronization. */
export function registerExplorer(explorer: Explorer): void {
  explorerRef = explorer;
  setupWindowTitleSync(explorer);
}

/** Double-click on a file opens it with the OS default application. */
export const openAction: NonNullable<ExplorerOptions["openAction"]> = () => {
  return (file: FStat) => {
    void openWithSystemApp(file);
  };
};

/** Actions shown in the explorer toolbar menu. */
export const explorerActions: readonly ExplorerAction[] = [
  {
    label: "Open Terminal Here",
    run: (explorer) => {
      const stat = explorer.getCurrentDir().stat;
      if (stat) {
        void runOpenInTerminal(stat.path);
      }
    },
  },
];

/** Handler for files dragged into the window from a system file manager. */
export const fileDropHandler: NonNullable<ExplorerOptions["fileDropHandler"]> =
  (
    dataTransfer,
    dirStat,
  ) => {
    void handleOsFileDrop(dataTransfer, dirStat);
  };

// ─── Open with system default app ────────────────────────────────────────────

async function openWithSystemApp(file: FStat): Promise<void> {
  try {
    // Trash items carry virtual trash:// paths — resolve to the real path.
    await window.xplorer.openPath(resolveTrashPath(file.path));
  } catch (err) {
    const msg = errorMessage(err);
    console.error(
      `Failed to open "${file.path}" with the system default application:`,
      err,
    );
    if (explorerRef) {
      showActionError(
        explorerRef,
        `Could not open "${trimTo(file.name, 40)}": ${trimTo(msg, 120)}`,
      );
    }
  }
}

// ─── Open in Terminal ────────────────────────────────────────────────────────

const openTerminalAction: FileAction = {
  label: "Open in Terminal",
  // Single file or directory. For a file the terminal opens in its parent
  // directory. Also matches the current-directory background menu (where the
  // lib passes the directory itself as the single "file"). Never shown for
  // trash locations: "restore first" is the only meaningful workflow there.
  match: (files) => files.length === 1 && !isTrashLocation(files[0]!),
  run: (files) => {
    const file = files[0]!;
    const dir = file.directory
      ? file.path
      : rendererPlatform().paths.dirname(file.path);
    void runOpenInTerminal(dir);
  },
};

async function runOpenInTerminal(dir: string): Promise<void> {
  try {
    await window.xplorer.openInTerminal(dir);
  } catch (err) {
    const msg = errorMessage(err);
    console.error(`Failed to open a terminal in "${dir}":`, err);
    if (explorerRef) {
      showActionError(
        explorerRef,
        `Could not open terminal: ${trimTo(msg, 120)}`,
      );
    }
  }
}

// ─── Open With… ──────────────────────────────────────────────────────────────

const openWithAction: FileAction = {
  label: "Open With…",
  // Exactly one selected FILE. Not for directories (the OS "open with"
  // dialog is file-only) and never for trash locations: OS trash storage is
  // not a place to launch applications from ("restore first" is the only
  // meaningful workflow there).
  match: (files) =>
    files.length === 1 && !files[0]!.directory && !isTrashLocation(files[0]!),
  run: (files) => {
    void runOpenWith(files[0]!);
  },
};

async function runOpenWith(file: FStat): Promise<void> {
  try {
    // Trash items carry virtual trash:// paths — resolve to the real path.
    await window.xplorer.openWith(resolveTrashPath(file.path));
  } catch (err) {
    const msg = errorMessage(err);
    console.error(
      `Failed to show the "Open With" dialog for "${file.path}":`,
      err,
    );
    if (explorerRef) {
      showActionError(
        explorerRef,
        `Could not open "Open With" for "${trimTo(file.name, 40)}": ${
          trimTo(msg, 120)
        }`,
      );
    }
  }
}

// ─── Delete Permanently ──────────────────────────────────────────────────────

const deletePermanentlyAction: FileAction = {
  label: "Delete Permanently",
  // Only shown when something is actually selected/right-clicked. (The lib's
  // `actionFilters` only gate its built-in menu entries, so visibility for
  // custom actions is controlled here via `match`.) Valid everywhere,
  // including inside the trash, where it purges the stored item.
  match: (files, { isCurrentDir }) => files.length > 0 && !isCurrentDir,
  run: (files, explorer) => {
    void runDeletePermanently([...files], explorer);
  },
};

async function runDeletePermanently(
  files: readonly FStat[],
  explorer: Explorer,
): Promise<void> {
  let confirmed: { answer: boolean } | undefined;
  try {
    confirmed = await explorer.prompt.ask({
      title: "Delete Permanently",
      message: files.length === 1
        ? `Permanently delete "${files[0]!.name}"? This cannot be undone.`
        : `Permanently delete ${files.length} items? This cannot be undone.`,
      confirmBtnLabel: "Delete",
      cancelBtnLabel: "Cancel",
    });
  } catch {
    // Prompt aborted (e.g. Escape) - treat as cancel.
    return;
  }
  if (!confirmed?.answer) {
    return;
  }

  const results = await Promise.allSettled(
    files.map((file) =>
      // Trash items carry virtual trash:// paths — resolve to the real path
      // (deleting a trash item permanently purges it from trash storage).
      window.xplorer.removePermanent(resolveTrashPath(file.path))
    ),
  );

  const deleteFailures = results
    .map((result, i) => ({ file: files[i]!, result }))
    .filter(
      (x): x is { file: FStat; result: PromiseRejectedResult } =>
        x.result.status === "rejected",
    );

  for (const { file, result } of deleteFailures) {
    console.error(
      `Failed to permanently delete "${file.path}":`,
      result.reason,
    );
  }

  if (deleteFailures.length > 0) {
    const names = deleteFailures.map(({ file }) => trimTo(file.name, 24)).join(
      ", ",
    );
    showActionError(
      explorer,
      deleteFailures.length === files.length
        ? `Could not delete: ${trimTo(names, 120)}`
        : `Deleted ${
          files.length - deleteFailures.length
        } of ${files.length} items; could not delete: ${trimTo(names, 100)}`,
    );
  }

  // Match the lib's built-in delete behavior, which refreshes afterwards. The
  // watcher integration also picks the change up; this just makes it instant.
  explorer.refresh();
}

// ─── Restore (trash items) ───────────────────────────────────────────────────

const restoreTrashAction: FileAction = {
  label: "Restore",
  // Trash items only, single or multi selection. The fs adapter tags every
  // trash-derived entry with FStat.trash (originalPath null when unknown —
  // restore then fails with a clear per-item error from the main process).
  match: (files) => files.length > 0 && files.every(isTrashItem),
  run: (files, explorer) => {
    void runRestoreTrash([...files], explorer);
  },
};

async function runRestoreTrash(
  files: readonly FStat[],
  explorer: Explorer,
): Promise<void> {
  const items: { trashPath: string; originalPath: string }[] = [];
  for (const file of files) {
    const originalPath = file.trash?.originalPath;
    if (originalPath == null) {
      continue;
    }
    items.push({
      // Trash items carry virtual trash:// paths — resolve to the real
      // trashed item path the main process knows.
      trashPath: resolveTrashPath(file.path),
      originalPath,
    });
  }

  if (items.length === 0) {
    // The tag matches trash-derived entries with unknown origin too (e.g.
    // items trashed outside this app on macOS/Windows, or nested entries of a
    // trashed directory); restoring them is impossible by design.
    showActionError(
      explorer,
      "The original location of the selected item(s) is unknown, so they cannot be restored.",
    );
    return;
  }

  // Items without a known original location are skipped by the filter above.
  const skipped = files.length - items.length;

  try {
    await window.xplorer.restoreTrash(items);
  } catch (err) {
    const msg = errorMessage(err);
    console.error("Failed to restore trash items:", err);
    showActionError(explorer, `Could not restore: ${trimTo(msg, 120)}`);
  }

  if (skipped > 0) {
    showActionError(
      explorer,
      `Restored ${items.length} of ${files.length} items; ${skipped} had an unknown original location and were left in the Trash.`,
    );
  }

  // No fs watcher covers the virtual trash location, so refresh explicitly
  // (the lib's built-in delete-refresh behavior, mirrored here).
  explorer.refresh();
}

// ─── Empty Trash (trash root background) ─────────────────────────────────────

const emptyTrashAction: FileAction = {
  label: "Empty Trash",
  // Available throughout the trash: the trash root's background menu (when
  // nothing is selected the lib passes the current directory itself as the
  // single "file") AND any trash item selection, wherever it is inside the
  // trash. Regular directories must never match.
  match: (files) => files.length > 0 && files.every(isTrashLocation),
  run: (_files, explorer) => {
    void runEmptyTrash(explorer);
  },
};

async function runEmptyTrash(explorer: Explorer): Promise<void> {
  let confirmed: { answer: boolean } | undefined;
  try {
    confirmed = await explorer.prompt.ask({
      title: "Empty Trash",
      message:
        "This permanently deletes ALL items in the Trash and cannot be undone.",
      confirmBtnLabel: "Empty",
      cancelBtnLabel: "Cancel",
    });
  } catch {
    // Prompt aborted (e.g. Escape) - treat as cancel.
    return;
  }
  if (!confirmed?.answer) {
    return;
  }

  try {
    await window.xplorer.emptyTrash();
  } catch (err) {
    const msg = errorMessage(err);
    console.error("Failed to empty the trash:", err);
    showActionError(explorer, `Could not empty the trash: ${trimTo(msg, 120)}`);
  }

  // When triggered from inside a trashed directory, that directory no longer
  // exists after the empty — return to the trash root view instead.
  const currentPath = explorer.getCurrentDir().stat?.path;
  if (currentPath !== undefined && currentPath !== TRASH_ROOT) {
    explorer.open(TRASH_ROOT);
  }

  // No fs watcher covers the virtual trash location, so refresh explicitly
  // (same as the Restore action above).
  explorer.refresh();
}

/** Custom per-file/directory context-menu actions. */
export const fileActions: readonly FileAction[] = [
  restoreTrashAction,
  emptyTrashAction,
  openWithAction,
  openTerminalAction,
  deletePermanentlyAction,
];

// ─── OS drag-in ──────────────────────────────────────────────────────────────

/**
 * Handles OS drag-in: files dropped into a directory (from a system file
 * manager, or from another application — including drags that were handed
 * to the OS by this app's own drag-out, which are indistinguishable from
 * external drags and therefore dropped back in as COPIES). The dropped
 * `File` objects are resolved to paths via the preload bridge and COPIED
 * into the target directory using the recursive/force `fs:copy` channel.
 *
 * (Internal, in-window drags never reach this handler: they use the lib's
 * own emulated drag, which performs MOVE directly.)
 *
 * Refreshing is left to the directory watcher (or the lib's refresh);
 * failures are reported visibly via the overlay.
 */
async function handleOsFileDrop(
  dataTransfer: DataTransfer,
  dirStat: FStat,
): Promise<void> {
  // Writing into the trash is not supported anywhere in the trash namespace
  // (the trash root is read-only; restore is the only way out).
  if (dirStat.path === TRASH_ROOT || dirStat.trash != null) {
    console.error("Drag-in: dropping files into the Trash is not supported.");
    if (explorerRef) {
      showActionError(explorerRef, "Files cannot be dropped into the Trash.");
    }
    return;
  }

  const dropped = Array.from(dataTransfer.files ?? []);
  if (dropped.length === 0) {
    return;
  }

  // Resolve absolute paths via the preload bridge; files without a resolvable
  // path (e.g. synthetic drags) are skipped and reported.
  const paths = dropped
    .map((file) => ({
      name: file.name,
      path: window.xplorer.getPathForFile(file),
    }))
    .filter((entry) => {
      if (entry.path) {
        return true;
      }
      console.error(
        `Drag-in: could not resolve the path of dropped file "${entry.name}"`,
      );
      return false;
    });

  if (paths.length === 0) {
    console.error("Drag-in: no dropped files had resolvable filesystem paths.");
    if (explorerRef) {
      showActionError(
        explorerRef,
        "Could not resolve the paths of the dropped files.",
      );
    }
    return;
  }

  const results = await Promise.allSettled(
    paths.map((entry) => window.xplorer.copy(entry.path, dirStat.path)),
  );

  const copyFailures = results
    .map((result, i) => ({ entry: paths[i]!, result }))
    .filter(
      (
        x,
      ): x is {
        entry: { name: string; path: string };
        result: PromiseRejectedResult;
      } => x.result.status === "rejected",
    );

  for (const { entry, result } of copyFailures) {
    console.error(
      `Drag-in: failed to copy "${entry.path}" into "${dirStat.path}":`,
      result.reason,
    );
  }

  if (copyFailures.length > 0 && explorerRef) {
    const names = copyFailures.map(({ entry }) => trimTo(entry.name, 24)).join(
      ", ",
    );
    showActionError(
      explorerRef,
      copyFailures.length === paths.length
        ? `Could not copy the dropped files: ${trimTo(names, 100)}`
        : `Copied ${
          paths.length - copyFailures.length
        } of ${paths.length} dropped items; failed: ${trimTo(names, 100)}`,
    );
  }
}

// ─── Window title sync ───────────────────────────────────────────────────────

/**
 * Keeps the BrowserWindow title in sync with the active tab's current
 * directory: `<dir basename> — Electron Xplorer`.
 */
function setupWindowTitleSync(explorer: Explorer): void {
  // `explorer.location` is the lib's derived signal of the active tab's
  // ExplorerLocation; `ExplorerLocation.signal` dispatches on every navigation
  // (push/replace/back/forward) of that tab. Returning it from the derive
  // function makes it a *dynamic dependency* (vanilla-jsx unwraps a signal
  // returned from a derive function), so this re-evaluates on tab switches AND
  // on navigation within the active tab - no polling.
  //
  // NOTE: fs-explorer's shipped d.ts degrades its vanilla-jsx signal-typed
  // fields to `any` (the "@ncpa0cpl/vanilla-jsx/signals" type references do not
  // resolve from the linked package), so an explicit parameter annotation is
  // required for the derive callback.
  const activePath = sig.derive(
    explorer.location,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (loc: any) => loc.signal as ReadonlySignal<Path>,
  );

  // `observe()` pins the derived signal in memory while attached, so no extra
  // reference needs to be held.
  activePath.observe((p) => {
    const basename = p.basename() || "Filesystem";
    window.xplorer
      .setWindowTitle(`${basename} — Electron Xplorer`)
      .catch((err) => {
        console.error("Failed to update the window title:", err);
      });
  });
}

// ─── Error feedback ──────────────────────────────────────────────────────────

/**
 * Shows a small dismissible error box in the explorer overlay. Kept inline
 * (no CSS file changes) so it stays isolated from other chunks.
 */
function showActionError(explorer: Explorer, message: string): void {
  const box = createElement(
    "div",
    {},
    createElement("div", {}, message),
    createElement(
      "button",
      { onclick: () => explorer.overlay.close() },
      "OK",
    ),
  ) as HTMLElement;
  box.style.cssText =
    "position:relative;display:flex;flex-direction:column;gap:12px;"
    + "align-items:center;background:#3a2020;color:#f2d5d5;border:1px solid #a55;"
    + "border-radius:8px;padding:16px 20px;font-size:14px;max-width:420px;";
  const msg = box.firstElementChild as HTMLElement;
  msg.style.cssText = "white-space:pre-wrap;word-break:break-word;";
  const btn = box.lastElementChild as HTMLElement;
  btn.style.cssText =
    "background:#7a3b3b;color:#fff;border:0;border-radius:6px;"
    + "padding:6px 18px;cursor:pointer;font-size:13px;";
  btn.onmouseenter = () => (btn.style.background = "#93494a");
  btn.onmouseleave = () => (btn.style.background = "#7a3b3b");

  explorer.overlay.display(box);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function trimTo(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
