import os from "node:os";
import path from "node:path";
import type { PlaceInfo, TrashRestoreItem } from "../../shared/fs-types";
import { openWithSystemDefault } from "./system-default-app";
import type { MainPlatform, MenuAcceleratorKey } from "./types";

/**
 * Degraded safe defaults for an unrecognized `process.platform`. Never
 * crashes, never guesses:
 *  - no terminal: `openInTerminal` rejects with a clear error (the
 *    `XPLORER_TERMINAL` override is intentionally not honored here - there
 *    is no platform to assume a shell/quoting convention for),
 *  - no app chooser: `openWithDialog` rejects with a clear error,
 *  - places: the home directory only,
 *  - validation: POSIX-style (leading "/"),
 *  - no trash support: empty listing, restore/empty reject,
 *  - Ctrl accelerators, no app menu.
 */

function openInTerminal(dir: string): Promise<void> {
  return Promise.reject(
    new Error(
      `Opening a terminal is not supported on this platform (dir: "${dir}").`,
    ),
  );
}

function openWithDialog(p: string): Promise<void> {
  return Promise.reject(
    new Error(
      `The native "Open With" dialog is not supported on this platform (file: "${p}").`,
    ),
  );
}

/** No trash layout is known for an unrecognized platform. */
async function listTrash(): Promise<never[]> {
  return [];
}

function restoreTrash(
  _items: ReadonlyArray<TrashRestoreItem>,
): Promise<void> {
  return Promise.reject(
    new Error("Restoring trash items is not supported on this platform."),
  );
}

function emptyTrash(): Promise<void> {
  return Promise.reject(
    new Error("Emptying the trash is not supported on this platform."),
  );
}

async function getStaticPlaces(): Promise<PlaceInfo[]> {
  const home = os.homedir();
  return [{ id: "static-home", label: "Home", path: home }];
}

function accelerator(key: MenuAcceleratorKey): string {
  switch (key) {
    case "new-window":
      return "Ctrl+N";
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
    openPath: openWithSystemDefault,
    openInTerminal,
    openWithDialog,
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
    // Same as win32/linux: drop the native frame; the titlebar renders its
    // own window-control buttons (right side).
    titlebarWindowOptions: () => ({ frame: false }),
    listTrash,
    restoreTrash,
    emptyTrash,
  };
}
