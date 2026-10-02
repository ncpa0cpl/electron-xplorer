import { BrowserWindow, ipcMain } from "electron";
import os from "node:os";
import type { PlaceInfo } from "../shared/fs-types";
import type { PlatformId } from "../shared/platform/types";
import { handle } from "./ipc";
import { getMainPlatform } from "./platform";

/**
 * System-level IPC handlers ("system:*" channels).
 *
 * Platform-dependent behavior (static places, terminal spawning) is
 * delegated to the main platform bridge (src/main/platform).
 */

/** Maximum window title length accepted over IPC. */
const MAX_WINDOW_TITLE_LENGTH = 200;

/** Registers all system handlers. Call once during app startup. */
export function registerSystemHandlers(): void {
  handle("system:getHomeDir", [], getHomeDir);
  handle("system:getStaticPlaces", [], getStaticPlaces);
  handle("system:openPath", ["path"], openPath);
  handle("system:openInTerminal", ["path"], openInTerminalHandler);
  handle("system:openWith", ["path"], openWithHandler);
  /**
   * Returns the platform id the renderer needs to build its shared `Platform`
   * (src/shared/platform). Registered with raw `ipcMain.handle` (no argument,
   * a plain `PlatformId` return) because ipc.ts's specs are for path-bearing
   * channels only.
   */
  ipcMain.handle(
    "system:getPlatformInfo",
    (): PlatformId => getMainPlatform().id,
  );
  /**
   * Registered with raw `ipcMain.handle` instead of the typed `handle` helper:
   * the helper's argument specs only support absolute-path strings, and a
   * window title is an arbitrary (short) string. Validation is done inline.
   */
  ipcMain.handle(
    "system:setWindowTitle",
    (event, title: unknown) => {
      if (typeof title !== "string") {
        throw new Error("system:setWindowTitle: title must be a string");
      }
      if (title.length > MAX_WINDOW_TITLE_LENGTH) {
        throw new Error(
          `system:setWindowTitle: title exceeds ${MAX_WINDOW_TITLE_LENGTH} characters`,
        );
      }
      BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
    },
  );
}

async function getHomeDir(): Promise<string> {
  return os.homedir();
}

/** Opens a file with its default application (per platform). */
async function openPath(p: string): Promise<void> {
  await getMainPlatform().openPath(p);
}

/** Opens a terminal emulator with the given directory as cwd (per platform). */
async function openInTerminalHandler(p: string): Promise<void> {
  await getMainPlatform().openInTerminal(p);
}

/**
 * Summons the OS-native "Open With" dialog for a file (per platform); user
 * cancellation inside the dialog is not an error.
 */
async function openWithHandler(p: string): Promise<void> {
  await getMainPlatform().openWithDialog(p);
}

/**
 * Well-known left-pane places for the running platform, existence-filtered
 * (see src/main/platform/*.ts). Shape matches fs-explorer's `Place`
 * interface (`{ id, label, path }`).
 */
async function getStaticPlaces(): Promise<PlaceInfo[]> {
  return getMainPlatform().getStaticPlaces();
}
