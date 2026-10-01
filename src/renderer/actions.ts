import { createElement } from "@ncpa0cpl/vanilla-jsx";
import type { ReadonlySignal } from "@ncpa0cpl/vanilla-jsx/signals";
import { sig } from "@ncpa0cpl/vanilla-jsx/signals";
import type {
  Explorer,
  ExplorerAction,
  ExplorerOptions,
  FileAction,
  FStat,
  Path,
} from "fs-explorer";
import { rendererPlatform } from "./platform";

/**
 * Shell integration for the explorer: system-default file opening, custom
 * context-menu actions ("Open in Terminal", "Delete Permanently"), OS
 * drag-in support and window title synchronization.
 *
 * Custom action error feedback uses `explorer.overlay.display` with a small
 * dismissible box (the lib's `actionError` signal is dispatched internally but
 * never rendered by any lib component, so it cannot be reused here).
 */

/** The live explorer instance; set once during bootstrap by `registerExplorer`. */
let explorerRef: Explorer | undefined;

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
    await window.xplorer.openPath(file.path);
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
  // lib passes the directory itself as the single "file").
  match: (files) => files.length === 1,
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

// ─── Delete Permanently ──────────────────────────────────────────────────────

const deletePermanentlyAction: FileAction = {
  label: "Delete Permanently",
  // Only shown when something is actually selected/right-clicked. (The lib's
  // `actionFilters` only gate its built-in menu entries, so visibility for
  // custom actions is controlled here via `match`.)
  match: (files) => files.length > 0,
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
    files.map((file) => window.xplorer.removePermanent(file.path)),
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

/** Custom per-file/directory context-menu actions. */
export const fileActions: readonly FileAction[] = [
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
