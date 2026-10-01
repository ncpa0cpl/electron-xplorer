import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  PlaceInfo,
  TrashEntryInfo,
  TrashRestoreItem,
} from "../../shared/fs-types";
import { createPlatform } from "../../shared/platform/types";
import { peekTrashRecord } from "../trash-records";
import { tryCustomTerminal, win32ShellQuote } from "./custom-terminal";
import { homeSubdirPlaces, isDirectory, placeId } from "./posix-places";
import { restoreErrMessage, restoreToOriginalLocation } from "./trash-common";
import type { MainPlatform, MenuAcceleratorKey } from "./types";

/**
 * Windows main-process platform implementation (untestable in this Linux dev
 * environment; implemented per documented platform conventions).
 *
 * Terminal priority order: Windows Terminal (`wt`), PowerShell, cmd.exe.
 * A set `XPLORER_TERMINAL` env var (full shell command line, see
 * custom-terminal.ts) overrides the whole priority list.
 *
 * Quoting choice (documented): all terminals are spawned with an args ARRAY
 * and Node's default (non-verbatim) Windows argument quoting, so paths with
 * spaces are quoted correctly by Node itself; `windowsVerbatimArguments` is
 * deliberately NOT set. Directories arrive in the app's canonical forward-
 * slash form (`C:/Users/me`), which every involved program accepts:
 *  - `wt -d <dir>`: Windows Terminal's `--directory` shorthand.
 *  - powershell: `-NoExit -Command "Set-Location -LiteralPath '<dir>'"` -
 *    single quotes are PowerShell's literal string; a `'` inside the path
 *    would break it (documented limitation; PowerShell doubling `''` would
 *    need verbatim args, so we accept the limitation instead).
 *  - cmd: `/K cd /d <dir>` - `/d` also switches the current drive.
 * `cwd` is set on every spawn as well, so even a terminal that ignores its
 * directory argument inherits it.
 */

interface TerminalSpec {
  readonly bin: string;
  readonly args: (dir: string) => string[];
}

const TERMINALS: readonly TerminalSpec[] = [
  {
    bin: "wt.exe",
    args: (dir) => ["-d", dir],
  },
  {
    bin: "powershell.exe",
    args: (
      dir,
    ) => ["-NoExit", "-Command", `Set-Location -LiteralPath '${dir}'`],
  },
  {
    bin: "cmd.exe",
    args: (dir) => ["/K", "cd", "/d", dir],
  },
];

async function openInTerminal(dir: string): Promise<void> {
  const st = await fs.stat(dir).catch((): undefined => undefined);
  if (!st?.isDirectory()) {
    throw new Error(`Cannot open terminal: "${dir}" is not a directory.`);
  }

  // User override via $XPLORER_TERMINAL wins over the wt/powershell/cmd
  // priority below.
  const custom = tryCustomTerminal(dir, win32ShellQuote);
  if (custom) {
    return custom;
  }

  for (const spec of TERMINALS) {
    if (await resolveOnPath(spec.bin)) {
      spawn(spec.bin, spec.args(dir), {
        cwd: dir,
        detached: true,
        stdio: "ignore",
      }).unref();
      return;
    }
  }

  throw new Error(
    "No terminal found. Install Windows Terminal (wt.exe), or ensure "
      + "powershell.exe / cmd.exe are on the PATH.",
  );
}

/**
 * Native "Open with" dialog via `rundll32 shell32.dll,OpenAs_RunDLLW <file>`.
 * OpenAs_RunDLLW spawns the dialog and returns immediately, so the call is
 * fire-and-forget (the dialog is owned by the shell, not by us). rundll32's
 * first argument must be the unquoted `<dll>,<entrypoint>` pair - it contains
 * no spaces, so Node's default Windows argv quoting passes it through
 * verbatim (see the quoting note at the top of this file).
 */
async function openWithDialog(p: string): Promise<void> {
  if (!(await resolveOnPath("rundll32.exe"))) {
    throw new Error(
      "Cannot open the \"Open With\" dialog: rundll32.exe was not found"
        + " on the PATH.",
    );
  }

  spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLLW", p], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/** `true` if `bin` resolves on the PATH (or is an app-execution alias). */
async function resolveOnPath(bin: string): Promise<boolean> {
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(
    Boolean,
  );
  for (const dir of pathDirs) {
    try {
      await fs.access(path.join(dir, bin));
      return true;
    } catch {
      // keep scanning
    }
  }
  // Windows "app execution aliases" (wt.exe among them) live under
  // %LOCALAPPDATA% and are not always on PATH for services; try env lookup.
  const aliasDir = process.env.LOCALAPPDATA;
  if (aliasDir) {
    try {
      await fs.access(path.join(aliasDir, "Microsoft", "WindowsApps", bin));
      return true;
    } catch {
      // fall through
    }
  }
  return false;
}

/** The user's home directory (USERPROFILE; unset on non-Windows hosts). */
function homeDir(): string {
  return process.env.USERPROFILE ?? "";
}

/**
 * Places: user profile subdirectories (existence-filtered) plus one place
 * per existing drive letter (A:..Z:, probed with fs.access once on call).
 * Drives are labeled `X:\`; Windows' real volume labels are not exposed by
 * Node's fs without native calls, so no fake "Local Disk (C:)" label is
 * attempted.
 */
async function getStaticPlaces(): Promise<PlaceInfo[]> {
  const home = homeDir();
  const places: PlaceInfo[] = home
    ? await homeSubdirPlaces([
      { label: "Home", subpath: "" },
      { label: "Desktop", subpath: "Desktop" },
      { label: "Documents", subpath: "Documents" },
      { label: "Downloads", subpath: "Downloads" },
      { label: "Music", subpath: "Music" },
      { label: "Pictures", subpath: "Pictures" },
      { label: "Videos", subpath: "Videos" },
    ])
    : [];

  // Drive enumeration: 26 existence probes, done once per call (startup).
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const drives = await Promise.all(
    letters.map(async (letter): Promise<PlaceInfo | null> => {
      const drivePath = `${letter}:\\`;
      if (await isDirectory(drivePath)) {
        return {
          id: placeId(`${letter}-drive`),
          label: `${letter}:\\`,
          path: drivePath,
        };
      }
      return null;
    }),
  );
  places.push(...drives.filter((p): p is PlaceInfo => p !== null));

  return places;
}

/**
 * Valid absolute native paths: drive-rooted (`C:\...`, also `C:/...`) or
 * UNC (`\\server\share[...]`). Delegates to the shared win32 Platform.
 */
function isValidAbsolutePath(p: string): boolean {
  return createPlatform("win32").paths.isAbsolute(p);
}

/**
 * Decoded xmedia URL paths on win32 arrive in one of two forms:
 *  - `/C:/Users/...`: the empty-authority URL form (`xmedia:///C:/...`)
 *    puts one spurious leading slash before a drive letter - strip it.
 *  - `//server/share/...`: UNC paths already begin with "//", so the URL
 *    form has four leading slashes and the decoded path is ALREADY a valid
 *    canonical UNC path - returned verbatim.
 * Anything that is not a valid absolute path in either form is rejected.
 */
function protocolPathToAbsolute(decodedUrlPath: string): string {
  if (isValidAbsolutePath(decodedUrlPath)) {
    return decodedUrlPath;
  }
  const stripped = decodedUrlPath.startsWith("/")
    ? decodedUrlPath.slice(1)
    : decodedUrlPath;
  if (isValidAbsolutePath(stripped)) {
    return stripped;
  }
  throw new Error(`not a valid absolute Windows path: "${decodedUrlPath}"`);
}

// ─── Trash (best-effort) ─────────────────────────────────────────────────────

/**
 * Recycle Bin enumeration via a detached PowerShell call using the
 * `Shell.Application` COM object (the bin has no readable filesystem layout
 * an app can rely on; `shell.trashItem` puts items into per-SID
 * `$Recycle.Bin/<SID>/$R...` folders that are hidden and permission-gated).
 *
 * Per item we extract:
 *  - `name` and the real underlying path (`FolderItem.Path`, e.g.
 *    `C:\$Recycle.Bin\<SID>\$RXXXX.txt`) - usable as a normal path for
 *    open/permanent-delete,
 *  - the original location via the `System.Recycle.DeletedFileOriginalLocation`
 *    extended property (newer Windows only; treated as unreliable - when it
 *    yields nothing the entry lists with `originalPath: null` and only the
 *    app's sidecar records can restore it),
 *  - deletion/modification dates and size (best-effort, may be `null`/0).
 */
const LIST_TRASH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$bin = (New-Object -ComObject Shell.Application).NameSpace(0xA)
$items = @()
foreach ($item in $bin.Items()) {
  $orig = $null
  try { $orig = [string]$item.ExtendedProperty('System.Recycle.DeletedFileOriginalLocation') } catch {}
  $deleted = $null
  try {
    $d = $item.ExtendedProperty('System.Recycle.DeletedDate')
    if ($d -is [datetime]) { $deleted = $d.ToString('o') } else { $deleted = [string]$d }
  } catch {}
  if (-not $deleted) { try { $deleted = [string]$bin.GetDetailsOf($item, 2) } catch {} }
  $size = 0
  try { $size = [long]$item.ExtendedProperty('System.Size') } catch {}
  $mtime = $null
  try {
    $m = $item.ExtendedProperty('System.DateModified')
    if ($m -is [datetime]) { $mtime = $m.ToString('o') }
  } catch {}
  $p = $null
  try { $p = [string]$item.Path } catch {}
  $items += [PSCustomObject]@{
    name = [string]$item.Name
    trashPath = $p
    originalPath = $orig
    deleted = $deleted
    size = $size
    mtime = $mtime
  }
}
ConvertTo-Json -InputObject $items -Depth 2 -Compress
`;

interface RecycleBinItem {
  readonly name: string;
  readonly trashPath: string | null;
  readonly originalPath: string | null;
  readonly deleted: string | null;
  readonly size: number;
  readonly mtime: string | null;
}

/** Runs a PowerShell script, returning its stdout (rejecting on failure). */
function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`powershell exited with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

/** `Date.parse` for PowerShell-provided date strings; null when unparseable. */
function parsePsDate(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Placeholder trashPath for bin entries whose real path the shell would not
 * reveal. Not a real filesystem path - the renderer maps it to `FStat.path`,
 * but IPC channels that require absolute native paths (open, permanent
 * delete) will correctly reject it. The `#<i>` keeps entries unique.
 */
function syntheticTrashPath(name: string, index: number): string {
  return `${name}#${index}`;
}

async function listTrash(): Promise<TrashEntryInfo[]> {
  const stdout = await runPowerShell(LIST_TRASH_SCRIPT).catch(() => "");
  if (!stdout.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter((raw): raw is RecycleBinItem =>
      typeof raw === "object" && raw !== null
      && typeof (raw as RecycleBinItem).name === "string"
    )
    .map((item, index): TrashEntryInfo => {
      const trashPath = item.trashPath
          && isValidAbsolutePath(item.trashPath)
        ? item.trashPath
        : syntheticTrashPath(item.name, index);
      return {
        name: item.name,
        trashPath,
        originalPath: item.originalPath
            && isValidAbsolutePath(item.originalPath)
          ? item.originalPath
          : null,
        deletionTime: parsePsDate(item.deleted),
        isDirectory: false,
        size: typeof item.size === "number" ? item.size : 0,
        mtimeMs: parsePsDate(item.mtime) ?? 0,
      };
    });
}

/**
 * Best-effort cleanup of the `$I...` metadata sibling the shell pairs with
 * every `$R...` file in the bin (a manual move leaves it behind and the bin
 * would list a ghost entry). The pair name is `$R` → `$I` plus the same
 * random suffix/extension.
 */
async function removeRecycleBinMetadata(trashPath: string): Promise<void> {
  const dir = path.dirname(trashPath);
  const base = path.basename(trashPath);
  if (!base.startsWith("$R")) {
    return;
  }
  const infoSibling = path.join(dir, `$I${base.slice(2)}`);
  await fs.rm(infoSibling, { force: true }).catch(() => {});
}

/**
 * Restores items:
 *  1. via a matching sidecar record (items trashed by this app) - the record
 *     is the source of truth for the original location,
 *  2. otherwise by invoking the shell item's default verb ("Restore") after
 *     relocating it in the bin by its real path - only attempted when the
 *     real path is known,
 *  3. otherwise the item is rejected.
 */
async function restoreTrash(
  items: ReadonlyArray<TrashRestoreItem>,
): Promise<void> {
  const failures: string[] = [];
  for (const item of items) {
    const name = path.basename(item.trashPath);
    const record = await peekTrashRecord(item.originalPath).catch(
      (): undefined => undefined,
    );
    try {
      if (record) {
        await restoreToOriginalLocation(item.trashPath, item.originalPath);
        await removeRecycleBinMetadata(item.trashPath);
      } else if (isValidAbsolutePath(item.trashPath)) {
        await invokeRecycleBinRestore(item.trashPath);
      } else {
        throw new Error("original location is not known for this item");
      }
    } catch (err) {
      failures.push(`${name}: ${restoreErrMessage(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not restore: ${failures.join("; ")}`);
  }
}

/**
 * Shell "Restore" verb for a bin item located by its real path. The verb is
 * invoked without a name (the bin's default verb), so it works across
 * Windows locales.
 */
async function invokeRecycleBinRestore(trashPath: string): Promise<void> {
  // Single-quoted PowerShell literal; embedded quotes are doubled.
  const literal = `'${trashPath.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
$bin = (New-Object -ComObject Shell.Application).NameSpace(0xA)
$item = $bin.Items() | Where-Object { $_.Path -eq ${literal} } | Select-Object -First 1
if (-not $item) { throw 'item not found in the Recycle Bin' }
$item.InvokeVerb()
`;
  await runPowerShell(script);
}

// ─── Empty Trash ─────────────────────────────────────────────────────────────

/** `Clear-RecycleBin` (PowerShell 5+ / Windows 8.1+); `-Force` skips the confirmation prompt. */
const CLEAR_RECYCLE_BIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
Clear-RecycleBin -Force
`;

/**
 * Fallback for hosts where `Clear-RecycleBin` is unavailable (or failed):
 * enumerates the bin via the `Shell.Application` COM object (same object
 * `listTrash` uses) and `Remove-Item -Recurse -Force`s each item's real
 * `$R...` path. Items the shell would not reveal a real path for are reported
 * as failures; the collected names are thrown as one aggregated error.
 */
const EMPTY_TRASH_FALLBACK_SCRIPT = `
$ErrorActionPreference = 'Stop'
$bin = (New-Object -ComObject Shell.Application).NameSpace(0xA)
$failed = @()
foreach ($item in $bin.Items()) {
  $p = $null
  try { $p = [string]$item.Path } catch {}
  if ($p) {
    try { Remove-Item -LiteralPath $p -Recurse -Force } catch { $failed += [string]$item.Name }
  } else {
    $failed += [string]$item.Name
  }
}
if ($failed.Count -gt 0) { throw ('could not delete: ' + ($failed -join '; ')) }
`;

/**
 * Empties the Recycle Bin: `Clear-RecycleBin -Force` first (documented cmdlet,
 * clears the current user's bin on every drive); when the cmdlet is missing or
 * fails, falls back to per-item shell enumeration + `Remove-Item` (see the
 * script above), so the feature still works on older/locked-down hosts.
 */
async function emptyTrash(): Promise<void> {
  try {
    await runPowerShell(CLEAR_RECYCLE_BIN_SCRIPT);
    return;
  } catch (err) {
    console.error(
      "Clear-RecycleBin failed; falling back to Recycle Bin enumeration:",
      err,
    );
  }
  await runPowerShell(EMPTY_TRASH_FALLBACK_SCRIPT);
}

function accelerator(key: MenuAcceleratorKey): string {
  switch (key) {
    case "new-tab":
      return "Ctrl+T";
    case "close-tab":
      return "Ctrl+W";
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

/** Windows main-process platform implementation. */
export function createWin32MainPlatform(): MainPlatform {
  return {
    id: "win32",
    getStaticPlaces,
    openInTerminal,
    openWithDialog,
    isValidAbsolutePath,
    protocolPathToAbsolute,
    accelerator,
    usesAppMenu: () => false,
    quitAfterAllWindowsClosed: () => true,
    // No native window decorations left at all: the titlebar renders its own
    // window-control buttons (right side).
    titlebarWindowOptions: () => ({ frame: false }),
    listTrash,
    restoreTrash,
    emptyTrash,
  };
}
