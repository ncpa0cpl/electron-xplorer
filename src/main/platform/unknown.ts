import os from "node:os";
import path from "node:path";
import type { PlaceInfo } from "../../shared/fs-types";
import type { MainPlatform, MenuAcceleratorKey } from "./types";

/**
 * Degraded safe defaults for an unrecognized `process.platform`. Never
 * crashes, never guesses:
 *  - no terminal: `openInTerminal` rejects with a clear error,
 *  - places: the home directory only,
 *  - validation: POSIX-style (leading "/"),
 *  - Ctrl accelerators, no app menu.
 */

function openInTerminal(dir: string): Promise<void> {
  return Promise.reject(
    new Error(
      `Opening a terminal is not supported on this platform (dir: "${dir}").`,
    ),
  );
}

async function getStaticPlaces(): Promise<PlaceInfo[]> {
  const home = os.homedir();
  return [{ id: "static-home", label: "Home", path: home }];
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

/** Unknown main-process platform implementation (degraded defaults). */
export function createUnknownMainPlatform(): MainPlatform {
  return {
    id: "unknown",
    getStaticPlaces,
    openInTerminal,
    isValidAbsolutePath: (p) => path.isAbsolute(p),
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
