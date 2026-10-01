import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { PlaceInfo } from "../../shared/fs-types";
import { homeSubdirPlaces, isDirectory, placeId } from "./posix-places";
import type { MainPlatform, MenuAcceleratorKey } from "./types";

/**
 * macOS main-process platform implementation (untestable in this Linux dev
 * environment; implemented per documented platform conventions).
 *
 * Terminal: `open -a <app> <dir>` - launching a directory with a terminal
 * application opens a new terminal window with that working directory. iTerm
 * is preferred when present (cheap existence probe of /Applications/iTerm.app);
 * otherwise Terminal.app. Documented macOS convention, not verified here.
 */

/** Cheap iTerm presence probe (a directory check, no app registration). */
const ITERM_APP_DIR = "/Applications/iTerm.app";

async function openInTerminal(dir: string): Promise<void> {
  const st = await fs.stat(dir).catch((): undefined => undefined);
  if (!st?.isDirectory()) {
    throw new Error(`Cannot open terminal: "${dir}" is not a directory.`);
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

/** macOS main-process platform implementation. */
export function createDarwinPlatform(): MainPlatform {
  return {
    id: "darwin",
    getStaticPlaces,
    openInTerminal,
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
  };
}
