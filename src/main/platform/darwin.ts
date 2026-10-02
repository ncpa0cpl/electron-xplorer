import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PlaceInfo,
  TrashEntryInfo,
  TrashRestoreItem,
} from "../../shared/fs-types";
import { getDefaultApp, setDefaultApp } from "../default-apps";
import { posixShellQuote, tryCustomTerminal } from "./custom-terminal";
import { homeSubdirPlaces, isDirectory, placeId } from "./posix-places";
import { openWithSystemDefault } from "./system-default-app";
import {
  removeDirEntries,
  restoreErrMessage,
  restoreToOriginalLocation,
  statTrashEntry,
  trashRecordsByBasename,
} from "./trash-common";
import type { MainPlatform, MenuAcceleratorKey } from "./types";

/**
 * macOS main-process platform implementation (untestable in this Linux dev
 * environment; implemented per documented platform conventions).
 *
 * Terminal: `open -a <app> <dir>` - launching a directory with a terminal
 * application opens a new terminal window with that working directory. iTerm
 * is preferred when present (cheap existence probe of /Applications/iTerm.app);
 * otherwise Terminal.app. Documented macOS convention, not verified here.
 * A set `XPLORER_TERMINAL` env var (full shell command line, see
 * custom-terminal.ts) overrides all of this.
 */

/** Cheap iTerm presence probe (a directory check, no app registration). */
const ITERM_APP_DIR = "/Applications/iTerm.app";

async function openInTerminal(dir: string): Promise<void> {
  const st = await fs.stat(dir).catch((): undefined => undefined);
  if (!st?.isDirectory()) {
    throw new Error(`Cannot open terminal: "${dir}" is not a directory.`);
  }

  // User override via $XPLORER_TERMINAL wins over the iTerm/Terminal choice.
  const custom = tryCustomTerminal(dir, posixShellQuote);
  if (custom) {
    return custom;
  }

  const hasITerm = await isDirectory(ITERM_APP_DIR);
  const terminalApp = hasITerm ? "iTerm" : "Terminal";

  // Fire-and-forget: `open` returns immediately once the app is launched.
  spawn("open", ["-a", terminalApp, dir], {
    cwd: dir,
    detached: true,
    stdio: "ignore",
  }).unref();
}

// ─── Open With (AppleScript application chooser) ─────────────────────────────

/** Runs a command to completion, returning its stdout (rejecting on failure). */
function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

/** `open` exits as soon as Launch Services has handed the file to the app. */
async function openWithApp(appPath: string, p: string): Promise<void> {
  await run("open", ["-a", appPath, p]);
}

/** Escapes a string for a double-quoted AppleScript string literal. */
function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * Native app-chooser dialog via AppleScript's `choose application`, then
 * `open -a <appPath> <file>` with the picked app, which `openPath` uses for
 * the file's extension from then on. Best-effort (this code never ran on a
 * real macOS host, like the rest of darwin.ts). If the user cancels the
 * chooser, osascript exits non-zero with a "User canceled" message - treated
 * as a no-op success, not an error.
 */
async function openWithDialog(p: string): Promise<void> {
  // `as alias` is required: on an application reference `POSIX path of` fails (-1728).
  const script =
    `POSIX path of (choose application with prompt "Choose an application to open \\"${
      appleScriptEscape(path.basename(p))
    }\\"" as alias)`;

  let appPath: string;
  try {
    appPath = (await run("osascript", ["-e", script])).trim();
  } catch (err) {
    // error -128 ("User canceled."): the user dismissed the chooser - no-op.
    if (err instanceof Error && /user canceled|-128/.test(err.message)) {
      return;
    }
    throw err;
  }
  if (!appPath) {
    return;
  }

  await openWithApp(appPath, p);
  await setDefaultApp(p, appPath);
}

/**
 * macOS's chooser has no "always open with" option, so the app keeps its own
 * per-extension defaults (src/main/default-apps.ts).
 */
async function openPath(p: string): Promise<void> {
  const appPath = await getDefaultApp(p);
  // A missing app may live on an unmounted volume, so its entry is kept.
  if (appPath && (await isDirectory(appPath))) {
    return openWithApp(appPath, p);
  }
  return openWithSystemDefault(p);
}

/**
 * Well-known user directories (macOS names: "Movies" instead of "Videos"),
 * plus /Applications and /Volumes.
 */
async function getStaticPlaces(): Promise<PlaceInfo[]> {
  const places = await homeSubdirPlaces([
    { label: "Home", subpath: "" },
    { label: "Desktop", subpath: "Desktop" },
    { label: "Documents", subpath: "Documents" },
    { label: "Downloads", subpath: "Downloads" },
    { label: "Movies", subpath: "Movies" },
    { label: "Music", subpath: "Music" },
    { label: "Pictures", subpath: "Pictures" },
  ]);

  // Applications and mounted volumes (existence-filtered).
  const extraDirs: Array<{ label: string; dir: string }> = [
    { label: "Applications", dir: "/Applications" },
    { label: "Volumes", dir: "/Volumes" },
  ];
  for (const { label, dir } of extraDirs) {
    if (await isDirectory(dir)) {
      places.push({ id: placeId(label), label, path: dir });
    }
  }

  return places;
}

function accelerator(key: MenuAcceleratorKey): string {
  switch (key) {
    case "new-tab":
      // Electron maps CmdOrCtrl to Cmd on darwin.
      return "CmdOrCtrl+T";
    case "close-tab":
      return "CmdOrCtrl+W";
    case "refresh":
      return "F5";
    case "back":
      return "Alt+Left";
    case "forward":
      return "Alt+Right";
    case "up":
      return "Alt+Up";
    case "home":
      return "Alt+Home";
  }
}

// ─── Trash (best-effort) ─────────────────────────────────────────────────────

/**
 * macOS does not record where a trashed item came from (Finder offers
 * "Put Back" via internal metadata Node cannot read), so entries are listed
 * from `~/.Trash` with `originalPath` filled in only from the app's sidecar
 * records (src/main/trash-records.ts) - i.e. only for items trashed by this
 * app. Restore therefore works off those records and rejects items whose
 * origin is unknown.
 */
async function listTrash(): Promise<TrashEntryInfo[]> {
  const trash = path.join(os.homedir(), ".Trash");
  const dirents = await fs.readdir(trash, { withFileTypes: true }).catch(
    (): undefined => undefined,
  );
  if (!dirents) {
    return [];
  }

  const liveNames = new Set(dirents.map((d) => d.name));
  const records = await trashRecordsByBasename(liveNames);

  return Promise.all(
    dirents.map(async (dirent): Promise<TrashEntryInfo> => {
      const trashPath = path.join(trash, dirent.name);
      const st = await statTrashEntry(trashPath);
      const record = records.get(dirent.name);
      return {
        name: dirent.name,
        trashPath,
        originalPath: record?.originalPath ?? null,
        deletionTime: record?.trashedAt ?? null,
        isDirectory: st ? st.isDirectory() : dirent.isDirectory(),
        size: st?.size ?? 0,
        mtimeMs: st?.mtimeMs ?? 0,
      };
    }),
  );
}

async function restoreTrash(
  items: ReadonlyArray<TrashRestoreItem>,
): Promise<void> {
  // The sidecar record is the only source of the original location; the
  // record's path wins over whatever the renderer cached.
  const liveNames = new Set(items.map((item) => path.basename(item.trashPath)));
  const records = await trashRecordsByBasename(liveNames);

  const failures: string[] = [];
  for (const item of items) {
    const name = path.basename(item.trashPath);
    const record = records.get(name);
    if (!record) {
      failures.push(`${name}: original location is not known for this item`);
      continue;
    }
    try {
      await restoreToOriginalLocation(item.trashPath, record.originalPath);
    } catch (err) {
      failures.push(`${name}: ${restoreErrMessage(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not restore: ${failures.join("; ")}`);
  }
}

/**
 * Empties `~/.Trash` permanently: every entry is deleted recursively, per-item
 * best-effort (failures aggregated into one error, same style as
 * `restoreTrash`). Deliberately NOT Finder's AppleScript "empty trash" — that
 * requires Automation permissions and pops consent dialogs; plain `fs.rm` on
 * the user's own `~/.Trash` needs none. A missing/unreadable `~/.Trash` is
 * treated as already empty (same convention as `listTrash` above).
 */
async function emptyTrash(): Promise<void> {
  const trash = path.join(os.homedir(), ".Trash");
  const failures: string[] = [];
  await removeDirEntries(trash, failures);
  if (failures.length > 0) {
    throw new Error(`Could not empty the trash: ${failures.join("; ")}`);
  }
}

/** macOS main-process platform implementation. */
export function createDarwinPlatform(): MainPlatform {
  return {
    id: "darwin",
    getStaticPlaces,
    openPath,
    openInTerminal,
    openWithDialog,
    // POSIX: absolute = leading "/".
    isValidAbsolutePath: (p) => path.isAbsolute(p),
    protocolPathToAbsolute: (p) => {
      if (!path.isAbsolute(p)) {
        throw new Error(`not a valid absolute POSIX path: "${p}"`);
      }
      return p;
    },
    accelerator,
    // macOS expects the application menu as the first menu.
    usesAppMenu: () => true,
    // macOS convention: the app keeps running (dock/menu bar) with no windows.
    quitAfterAllWindowsClosed: () => false,
    // Keep the native traffic lights; hide only the native title bar.
    titlebarWindowOptions: () => ({ titleBarStyle: "hidden" }),
    listTrash,
    restoreTrash,
    emptyTrash,
  };
}
