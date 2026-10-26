import os from "node:os";
import path from "node:path";
import type { PlaceInfo, TrashRestoreItem } from "../../shared/fs-types";
import type { PlatformId } from "../../shared/platform/types";
import { openWithSystemDefault } from "./system-default-app";
import type { MenuAcceleratorKey, TitlebarWindowOptions } from "./types";

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
 *
 * The class object itself is the MainPlatform implementation (its static side
 * satisfies the interface; conformance is type-checked in platform/index.ts).
 */
export class UnknownPlatform {
  static readonly id: PlatformId = "unknown";

  private static terminalTemplate: string | undefined = undefined;
  static setTerminalTemplate(template: string | undefined) {
    this.terminalTemplate = template;
  }

  static openPath(p: string): Promise<void> {
    return openWithSystemDefault(p);
  }

  static openInTerminal(dir: string): Promise<void> {
    return Promise.reject(
      new Error(
        `Opening a terminal is not supported on this platform (dir: "${dir}").`,
      ),
    );
  }

  static openWithDialog(p: string): Promise<void> {
    return Promise.reject(
      new Error(
        `The native "Open With" dialog is not supported on this platform (file: "${p}").`,
      ),
    );
  }

  /** No trash layout is known for an unrecognized platform. */
  static async listTrash(): Promise<never[]> {
    return [];
  }

  static restoreTrash(
    _items: ReadonlyArray<TrashRestoreItem>,
  ): Promise<void> {
    return Promise.reject(
      new Error("Restoring trash items is not supported on this platform."),
    );
  }

  static emptyTrash(): Promise<void> {
    return Promise.reject(
      new Error("Emptying the trash is not supported on this platform."),
    );
  }

  static async getStaticPlaces(): Promise<PlaceInfo[]> {
    const home = os.homedir();
    return [{ id: "static-home", label: "Home", path: home }];
  }

  static accelerator(key: MenuAcceleratorKey): string {
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

  static isValidAbsolutePath(p: string): boolean {
    return path.isAbsolute(p);
  }

  static protocolPathToAbsolute(p: string): string {
    if (!path.isAbsolute(p)) {
      throw new Error(`not a valid absolute POSIX path: "${p}"`);
    }
    return p;
  }

  static usesAppMenu(): boolean {
    return false;
  }

  static quitAfterAllWindowsClosed(): boolean {
    return true;
  }

  // Same as win32/linux: drop the native frame; the titlebar renders its
  // own window-control buttons (right side).
  static titlebarWindowOptions(): TitlebarWindowOptions {
    return { frame: false };
  }
}
