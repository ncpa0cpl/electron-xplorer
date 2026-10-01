import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { PlaceInfo } from "../../shared/fs-types";
import { homeSubdirPlaces, isDirectory } from "./posix-places";
import type { MainPlatform, MenuAcceleratorKey } from "./types";

/**
 * Linux main-process platform implementation.
 *
 * Terminal detection: `$TERMINAL` (if it resolves to an executable) wins,
 * otherwise the first available binary from `DETECTION_ORDER`.
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

/** Linux main-process platform implementation. */
export function createLinuxPlatform(): MainPlatform {
  return {
    id: "linux",
    getStaticPlaces,
    openInTerminal,
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
  };
}
