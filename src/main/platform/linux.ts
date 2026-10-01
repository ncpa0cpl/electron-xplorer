import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  PlaceInfo,
  TrashEntryInfo,
  TrashRestoreItem,
} from "../../shared/fs-types";
import { posixShellQuote, tryCustomTerminal } from "./custom-terminal";
import { homeSubdirPlaces, isDirectory } from "./posix-places";
import {
  removeDirEntries,
  restoreErrMessage,
  restoreToOriginalLocation,
  statTrashEntry,
  trashRecordsByBasename,
} from "./trash-common";
import type { MainPlatform, MenuAcceleratorKey } from "./types";

/**
 * Linux main-process platform implementation.
 *
 * Terminal detection: `$XPLORER_TERMINAL` (a full shell command line, see
 * custom-terminal.ts) wins when set, then `$TERMINAL` (if it resolves to an
 * executable - a bare binary, spawned without a shell), otherwise the first
 * available binary from `DETECTION_ORDER`.
 */

/**
 * How to tell a given terminal binary to open in a specific directory.
 * `cwdArgs(dir)` produces the arguments; `spawn`'s own `cwd` option is always
 * set as well, so terminals that take no directory argument (e.g.
 * `x-terminal-emulator`, which may point at any backend) inherit it.
 */
interface TerminalSpec {
  readonly bin: string;
  readonly cwdArgs: (dir: string) => string[];
}

/**
 * Argument conventions, verified against each terminal's man page:
 *  - gnome-terminal / xfce4-terminal / tilix / foot: `--working-directory=DIR`
 *  - konsole: `--workdir DIR`
 *  - alacritty: `--working-directory DIR`
 *  - kitty: `--directory DIR`
 */
const KNOWN_TERMINALS: Record<string, TerminalSpec> = {
  "gnome-terminal": {
    bin: "gnome-terminal",
    cwdArgs: (dir) => [`--working-directory=${dir}`],
  },
  konsole: {
    bin: "konsole",
    cwdArgs: (dir) => ["--workdir", dir],
  },
  "xfce4-terminal": {
    bin: "xfce4-terminal",
    cwdArgs: (dir) => [`--working-directory=${dir}`],
  },
  "x-terminal-emulator": {
    bin: "x-terminal-emulator",
    // Debian alternatives symlink - the actual backend is unknown, so pass no
    // directory flag and rely on the spawn `cwd` being inherited.
    cwdArgs: () => [],
  },
  alacritty: {
    bin: "alacritty",
    cwdArgs: (dir) => ["--working-directory", dir],
  },
  kitty: {
    bin: "kitty",
    cwdArgs: (dir) => ["--directory", dir],
  },
  tilix: {
    bin: "tilix",
    cwdArgs: (dir) => [`--working-directory=${dir}`],
  },
  foot: {
    bin: "foot",
    cwdArgs: (dir) => [`--working-directory=${dir}`],
  },
};

/** Fallback detection order, first available binary wins. */
const DETECTION_ORDER = [
  "gnome-terminal",
  "konsole",
  "xfce4-terminal",
  "x-terminal-emulator",
  "alacritty",
  "kitty",
  "tilix",
  "foot",
] as const;

interface ResolvedTerminal {
  readonly bin: string;
  readonly cwdArgs: (dir: string) => string[];
}

/**
 * Picks a terminal binary:
 *  1. `$TERMINAL` when it resolves to an executable (known binaries get their
 *     directory flag; unknown ones are spawned bare so they inherit `cwd`),
 *  2. otherwise the first available binary from `DETECTION_ORDER`.
 */
async function findTerminal(): Promise<ResolvedTerminal | undefined> {
  const envTerminal = process.env.TERMINAL?.trim();
  if (envTerminal) {
    const bin = path.basename(envTerminal);
    if (await resolveOnPath(envTerminal)) {
      return KNOWN_TERMINALS[bin]
        ?? { bin: envTerminal, cwdArgs: (): string[] => [] };
    }
  }

  for (const bin of DETECTION_ORDER) {
    if (await resolveOnPath(bin)) {
      return KNOWN_TERMINALS[bin];
    }
  }

  return undefined;
}

/** `true` if `bin` points at an executable file (absolute) or is on `$PATH`. */
async function resolveOnPath(bin: string): Promise<boolean> {
  if (bin.includes(path.sep)) {
    return isExecutable(bin);
  }

  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(
    Boolean,
  );
  for (const dir of pathDirs) {
    if (await isExecutable(path.join(dir, bin))) {
      return true;
    }
  }
  return false;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function openInTerminal(dir: string): Promise<void> {
  const st = await fs.stat(dir).catch((): undefined => undefined);
  if (!st?.isDirectory()) {
    throw new Error(`Cannot open terminal: "${dir}" is not a directory.`);
  }

  // User override via $XPLORER_TERMINAL wins over everything below
  // (including the $TERMINAL variable).
  const custom = tryCustomTerminal(dir, posixShellQuote);
  if (custom) {
    return custom;
  }

  const spec = await findTerminal();
  if (!spec) {
    throw new Error(
      "No terminal emulator found. Install one of: "
        + DETECTION_ORDER.join(", ")
        + " (or set the $TERMINAL environment variable).",
    );
  }

  spawn(spec.bin, spec.cwdArgs(dir), {
    cwd: dir,
    detached: true,
    stdio: "ignore",
  }).unref();
}

// ─── Open With (xdg-desktop-portal app chooser) ──────────────────────────────

/**
 * Python/GLib helper that summons the DE-native "Select application" dialog
 * via the xdg-desktop-portal `OpenFile` method with `ask: true` (the chooser
 * dialog appears even when a default application is set), and reports a
 * single status line on stdout when the dialog finishes:
 *
 *   OK         - the user picked an application (the portal launches it)
 *   CANCELLED  - the user dismissed the dialog (treated as no-op success)
 *   TIMEOUT    - safety valve, the dialog was open for more than 10 minutes
 *   NO_GI      - python3-gobject (GLib bindings) is not installed
 *   ERR <msg>  - no session bus / no portal service / portal error response
 *
 * Why not the `gdbus` CLI approach as planned originally (both behaviors
 * verified empirically on this dev machine against xdg-desktop-portal 1.22):
 *  - modern portals explicitly reject `file:` URIs in `OpenURI`
 *    (`SchemeSupported("file")` returns `false`; the broker refuses the
 *    request with response code 2 because it cannot resolve a content type
 *    for `file:` - local files must go through `OpenFile`, which requires
 *    UNIX fd passing that no CLI tool (gdbus/busctl/dbus-send) can do),
 *  - the portal cancels a request as soon as the calling D-Bus connection
 *    disappears, and a fire-and-forget `gdbus call` process exits right
 *    after the method reply - the request (and with it the dialog) would be
 *    cancelled instantly. The calling connection must stay alive for as
 *    long as the dialog is open.
 * A tiny GLib client satisfies both constraints; `python3` + python3-gobject
 * is the one near-universally available D-Bus binding on desktop distros.
 * When it is missing, this feature rejects with a clear error (no in-app
 * fallback picker is implemented on purpose).
 */
const OPEN_WITH_PORTAL_HELPER = `
import os, sys

try:
    from gi.repository import Gio, GLib
except ImportError:
    print("NO_GI", flush=True)
    sys.exit(0)

def fail(message):
    print("ERR " + message, flush=True)
    sys.exit(1)

path = sys.argv[1] if len(sys.argv) > 1 else ""
if not path:
    fail("no file path given")

try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
except Exception as err:
    fail("no session bus: " + str(err))

handle_token = "xplorer" + str(os.getpid())

loop = GLib.MainLoop()
state = {"response": None}

def on_response(_conn, _sender, _path, _iface, _signal, params):
    state["response"] = params[0]
    loop.quit()

# The portal emits the Response signal on our request object only, and the
# request path is derived from our unique bus name + handle token (dots in
# the bus name become underscores).
request_path = "/org/freedesktop/portal/desktop/request/" + bus.get_unique_name()[1:].replace(".", "_") + "/" + handle_token
bus.signal_subscribe(
    "org.freedesktop.portal.Desktop",
    "org.freedesktop.portal.Request",
    "Response",
    request_path,
    None,
    Gio.DBusSignalFlags.NONE,
    on_response,
)

try:
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
except Exception as err:
    fail("cannot open file: " + str(err))

fd_list = Gio.UnixFDList()
fd_list.append(fd)

options = GLib.Variant("a{sv}", {
    "ask": GLib.Variant("b", True),
    "handle_token": GLib.Variant("s", handle_token),
})
params = GLib.Variant.new_tuple(
    GLib.Variant.new_string(""),
    GLib.Variant("h", 0),
    options,
)

try:
    bus.call_with_unix_fd_list_sync(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.OpenURI",
        "OpenFile",
        params,
        GLib.VariantType("(o)"),
        Gio.DBusCallFlags.NONE,
        -1,
        fd_list,
        None,
    )
except Exception as err:
    fail("portal OpenFile call failed: " + str(err))

os.close(fd)

def on_timeout():
    state["response"] = "TIMEOUT"
    loop.quit()

# Safety valve: never keep the process (and thus the dialog) alive forever.
GLib.timeout_add_seconds(600, on_timeout)
loop.run()

response = state["response"]
if response == 0:
    print("OK", flush=True)
elif response == 1:
    print("CANCELLED", flush=True)
elif response == "TIMEOUT":
    print("TIMEOUT", flush=True)
else:
    print("ERR portal responded with code " + str(response), flush=True)
`;

/** Clear error used whenever no native "Open With" dialog can be summoned. */
const NO_OPEN_WITH_DIALOG_MSG =
  "No native \"Open With\" dialog available on this system"
  + " (needs xdg-desktop-portal + python3-gobject/GLib).";

/**
 * Runs the portal helper and waits for it to finish. The helper holds the
 * D-Bus connection the portal request lives on (dropping it cancels the
 * dialog), so this resolves when the user closes the dialog, not when the
 * dialog merely appears. User cancellation inside the dialog is not an
 * error.
 */
async function openWithDialog(p: string): Promise<void> {
  const st = await fs.stat(p).catch((): undefined => undefined);
  if (!st) {
    throw new Error(
      `Cannot open the "Open With" dialog: "${p}" does not exist.`,
    );
  }

  const status = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      "python3",
      ["-c", OPEN_WITH_PORTAL_HELPER, p],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", (err) => {
      reject(new Error(`${NO_OPEN_WITH_DIALOG_MSG} (python3: ${err.message})`));
    });
    proc.on("close", (code) => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1] ?? "";
      if (last) {
        resolve(last);
        return;
      }
      reject(
        new Error(
          `${NO_OPEN_WITH_DIALOG_MSG} (helper exited with ${code}${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          })`,
        ),
      );
    });
  });

  if (status === "OK" || status === "CANCELLED" || status === "TIMEOUT") {
    return;
  }
  if (status === "NO_GI") {
    throw new Error(NO_OPEN_WITH_DIALOG_MSG + " (python3-gobject missing).");
  }
  throw new Error(
    `${NO_OPEN_WITH_DIALOG_MSG} (${
      status.startsWith("ERR ")
        ? status.slice(4)
        : `unexpected helper status "${status}"`
    }).`,
  );
}

/** Well-known user directories, plus the filesystem root. */
async function getStaticPlaces(): Promise<PlaceInfo[]> {
  const places = await homeSubdirPlaces([
    { label: "Home", subpath: "" },
    { label: "Desktop", subpath: "Desktop" },
    { label: "Documents", subpath: "Documents" },
    { label: "Downloads", subpath: "Downloads" },
    { label: "Music", subpath: "Music" },
    { label: "Pictures", subpath: "Pictures" },
    { label: "Videos", subpath: "Videos" },
  ]);

  if (await isDirectory(path.sep)) {
    places.push({ id: "filesystem-root", label: "Filesystem", path: path.sep });
  }

  return places;
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

// ─── Trash (FreeDesktop spec) ────────────────────────────────────────────────

/**
 * The home trash: `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`).
 * Contents live in `files/`, metadata in `info/<name>.trashinfo`. Per-drive
 * trashes (`.Trash-<uid>` on other mounts) are not read here - the home trash
 * is where `gio trash`/`shell.trashItem` put items deleted from the home
 * volume, which covers the app's usage.
 */
function trashDir(): string {
  return process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "Trash")
    : path.join(os.homedir(), ".local", "share", "Trash");
}

interface TrashInfo {
  readonly originalPath: string | null;
  readonly deletionTime: number | null;
}

/**
 * `Path=` values are percent-encoded (URL escaping). Malformed escapes fall
 * back to the raw value.
 */
function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parses a `[Trash Info]` file:
 *  - `Path=` is percent-encoded; absolute for home-trash entries (relative
 *    paths belong to per-drive trashes whose mount point is unknowable here,
 *    so they yield `null` and the item is listed as unrestorable),
 *  - `DeletionDate=` is a local-time ISO string without a zone
 *    (`2024-01-01T12:00:00`), which the ES spec's `Date.parse` reads as local
 *    time.
 */
async function parseTrashInfo(file: string): Promise<TrashInfo> {
  let originalPath: string | null = null;
  let deletionTime: number | null = null;
  try {
    const content = await fs.readFile(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq === -1) {
        continue;
      }
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === "Path") {
        const decoded = percentDecode(value);
        originalPath = path.isAbsolute(decoded) ? decoded : null;
      } else if (key === "DeletionDate") {
        const parsed = Date.parse(value);
        deletionTime = Number.isNaN(parsed) ? null : parsed;
      }
    }
  } catch {
    // Tolerated below via the null fields.
  }
  return { originalPath, deletionTime };
}

/**
 * Lists the home trash: every entry in `files/` becomes a TrashEntryInfo
 * whose `trashPath` is the real absolute path (so open/delete/copy work on
 * it unchanged). Original locations come from the authoritative `.trashinfo`
 * metadata, falling back to the app's sidecar records (e.g. when an item was
 * trashed without metadata); entries with neither list with `originalPath:
 * null`.
 */
async function listTrash(): Promise<TrashEntryInfo[]> {
  const trash = trashDir();
  const filesDir = path.join(trash, "files");
  const dirents = await fs.readdir(filesDir, { withFileTypes: true }).catch(
    (): undefined => undefined,
  );
  if (!dirents) {
    return [];
  }

  const liveNames = new Set(dirents.map((d) => d.name));

  // [Trash Info] metadata, matched to entries by basename (minus .trashinfo).
  const infos = new Map<string, TrashInfo>();
  const infoEntries = await fs.readdir(path.join(trash, "info")).catch(
    (): readonly string[] => [],
  );
  await Promise.all(
    infoEntries.map(async (name) => {
      if (!name.endsWith(".trashinfo")) {
        return;
      }
      infos.set(
        name.slice(0, -".trashinfo".length),
        await parseTrashInfo(path.join(trash, "info", name)),
      );
    }),
  );

  const records = await trashRecordsByBasename(liveNames);

  return Promise.all(
    dirents.map(async (dirent): Promise<TrashEntryInfo> => {
      const trashPath = path.join(filesDir, dirent.name);
      const st = await statTrashEntry(trashPath);
      const info = infos.get(dirent.name);
      const record = records.get(dirent.name);
      return {
        name: dirent.name,
        trashPath,
        originalPath: info?.originalPath ?? record?.originalPath ?? null,
        deletionTime: info?.deletionTime ?? record?.trashedAt ?? null,
        isDirectory: st ? st.isDirectory() : dirent.isDirectory(),
        size: st?.size ?? 0,
        mtimeMs: st?.mtimeMs ?? 0,
      };
    }),
  );
}

/**
 * `.trashinfo` file backing a `files/` entry: `<trash>/files/<name>` is
 * described by `<trash>/info/<name>.trashinfo`.
 */
function trashInfoFor(trashPath: string): string {
  return path.join(
    path.dirname(path.dirname(trashPath)),
    "info",
    `${path.basename(trashPath)}.trashinfo`,
  );
}

/**
 * Restores items to their recorded original locations (parent directories
 * are created as needed, collisions get a numeric suffix, nothing is ever
 * overwritten). Per-item failures are collected and reported together; the
 * matching `.trashinfo` metadata is removed so no ghost entries remain.
 */
async function restoreTrash(
  items: ReadonlyArray<TrashRestoreItem>,
): Promise<void> {
  const failures: string[] = [];
  for (const item of items) {
    const name = path.basename(item.trashPath);
    if (
      !path.isAbsolute(item.trashPath) || !path.isAbsolute(item.originalPath)
    ) {
      failures.push(`${name}: not an absolute path`);
      continue;
    }
    try {
      await restoreToOriginalLocation(item.trashPath, item.originalPath);
      await fs.rm(trashInfoFor(item.trashPath), { force: true }).catch(
        () => {},
      );
    } catch (err) {
      failures.push(`${name}: ${restoreErrMessage(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not restore: ${failures.join("; ")}`);
  }
}

/**
 * Empties the home trash permanently (FreeDesktop spec):
 *  - every entry of `files/` is deleted recursively (directories included),
 *  - the matching `info/<name>.trashinfo` metadata is removed with it (kept
 *    for entries whose deletion FAILED, so they stay listed/restorable),
 *  - `expunged/` — the spec's temporary storage for items another process is
 *    concurrently emptying — is cleared too (best-effort; the dir is optional
 *    and its absence is not an error).
 *
 * Per-item best-effort: one unremovable entry does not block the rest; the
 * collected failures are rejected as one aggregated error (same style as
 * `restoreTrash`). A missing trash directory is treated as already empty.
 */
async function emptyTrash(): Promise<void> {
  const trash = trashDir();
  const filesDir = path.join(trash, "files");

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(filesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return; // No trash (or no files/ dir): nothing to delete.
    }
    // Anything else (e.g. EACCES) means the trash CANNOT be emptied.
    throw new Error(
      `Could not empty the trash: cannot read "${filesDir}": ${
        restoreErrMessage(err)
      }`,
    );
  }

  const failures: string[] = [];
  for (const dirent of dirents) {
    const entryPath = path.join(filesDir, dirent.name);
    try {
      await fs.rm(entryPath, { recursive: true, force: true });
      // The metadata goes with the item; a leftover would be a ghost entry.
      await fs.rm(trashInfoFor(entryPath), { force: true }).catch(() => {});
    } catch (err) {
      failures.push(`${dirent.name}: ${restoreErrMessage(err)}`);
    }
  }

  await removeDirEntries(path.join(trash, "expunged"), failures);

  if (failures.length > 0) {
    throw new Error(`Could not empty the trash: ${failures.join("; ")}`);
  }
}

/** Linux main-process platform implementation. */
export function createLinuxPlatform(): MainPlatform {
  return {
    id: "linux",
    getStaticPlaces,
    openInTerminal,
    openWithDialog,
    isValidAbsolutePath: (p) => path.isAbsolute(p),
    // POSIX xmedia URLs are the native path verbatim (the empty-authority
    // URL form `xmedia:///abs/path` decodes to `/abs/path`).
    protocolPathToAbsolute: (p) => {
      if (!path.isAbsolute(p)) {
        throw new Error(`not a valid absolute POSIX path: "${p}"`);
      }
      return p;
    },
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
