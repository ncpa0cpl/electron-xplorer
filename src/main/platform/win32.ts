import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { PlaceInfo } from "../../shared/fs-types";
import { createPlatform } from "../../shared/platform/types";
import { homeSubdirPlaces, isDirectory, placeId } from "./posix-places";
import type { MainPlatform, MenuAcceleratorKey } from "./types";

/**
 * Windows main-process platform implementation (untestable in this Linux dev
 * environment; implemented per documented platform conventions).
 *
 * Terminal priority order: Windows Terminal (`wt`), PowerShell, cmd.exe.
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
    isValidAbsolutePath,
    protocolPathToAbsolute,
    accelerator,
    usesAppMenu: () => false,
    quitAfterAllWindowsClosed: () => true,
  };
}
