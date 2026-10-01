/**
 * Shared types used by both the main process IPC handlers and the preload
 * bridge. These must only ever describe data that can survive the structured
 * clone performed by Electron's IPC (plain objects, strings, numbers,
 * booleans, typed arrays).
 */

import type { LaunchApi } from "./launch-types";
import type { MediaApi } from "./media-types";
import type { MenuApi } from "./menu-types";
import type { PlatformId } from "./platform/types";
import type { WatchApi } from "./watch-types";

/**
 * One filesystem entry as returned by the batched `readdirStat` handler and
 * the `stat` handler. This is a superset of what the fs-explorer library's
 * `FStat` needs - the renderer adapter maps it to `FStat`.
 */
export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly atimeMs: number;
  /** Real `fs.access(path, R_OK)` result. */
  readonly readable: boolean;
  /** Real `fs.access(path, W_OK)` result. */
  readonly writable: boolean;
}

/**
 * A left-pane shortcut. Shape matches the fs-explorer library's
 * `Place` interface (`{ id, label, path }`) so it can be passed directly as
 * `ExplorerOptions.staticPlaces`.
 */
export interface PlaceInfo {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

/**
 * File operations exposed over IPC ("fs:*" channels).
 */
export interface FsApi {
  /**
   * Lists a directory and stats every entry in a single IPC round trip.
   * Entries whose stat fails (e.g. broken symlinks) are kept with best-effort
   * dirent-derived info rather than dropped.
   */
  readdirStat(dir: string): Promise<DirEntry[]>;
  /** Stats a single path (follows symlinks). */
  stat(path: string): Promise<DirEntry>;
  /** `true` if anything exists at the path. */
  exists(path: string): Promise<boolean>;
  /** `true` if a directory exists at the path. */
  dirExists(path: string): Promise<boolean>;
  /** Recursive copy; overwrites existing targets (the lib prompts first). */
  copy(from: string, to: string): Promise<void>;
  /**
   * Move via rename; falls back to copy+remove on cross-device (EXDEV)
   * errors.
   */
  move(from: string, to: string): Promise<void>;
  /** Permanent recursive delete (the renderer adapter uses `trash` instead). */
  remove(path: string): Promise<void>;
  /** Creates a directory, creating missing parents as needed. */
  mkdir(path: string): Promise<void>;
  /** Creates an empty file without truncating an existing one. */
  touch(path: string): Promise<void>;
  /** Reads a whole file as bytes. */
  readFile(path: string): Promise<Uint8Array>;
}

/**
 * System-level operations exposed over IPC ("system:*" channels).
 */
export interface SystemApi {
  getHomeDir(): Promise<string>;
  getStaticPlaces(): Promise<PlaceInfo[]>;
  /** Moves a path to the OS trash (registered on the "fs:trash" channel). */
  trash(path: string): Promise<void>;
  /**
   * Opens a path with the OS default application. Rejects with the error
   * message returned by `shell.openPath` when the launch fails.
   */
  openPath(path: string): Promise<void>;
  /** Opens a terminal emulator with the given directory as cwd. */
  openInTerminal(path: string): Promise<void>;
  /**
   * The running platform's id, used by the renderer to build its shared
   * `Platform` implementation (src/shared/platform). The ONLY channel over
   * which platform identity crosses the process boundary - the renderer
   * never detects the platform itself.
   */
  getPlatformInfo(): Promise<PlatformId>;
  /**
   * Permanently deletes a path, bypassing the OS trash. Registered on the
   * existing "fs:remove" channel.
   */
  removePermanent(path: string): Promise<void>;
  /** Sets the BrowserWindow title (validated to be ≤ 200 characters). */
  setWindowTitle(title: string): Promise<void>;
}

/**
 * OS drag-and-drop helpers. `getPathForFile` must run in the preload because
 * `webUtils.getPathForFile` needs privileged access to `File` objects coming
 * from an OS drag into the window.
 */
export interface DndApi {
  /** Absolute filesystem path of a `File` dropped from a system file manager. */
  getPathForFile(file: File): string;
  /**
   * Starts a native OS drag of the given absolute paths. Called when an
   * emulated drag leaves the window (while the pointer grab is still live):
   * the main process hands the paths to `webContents.startDrag`, which takes
   * over the in-progress drag ("system:drag-out" channel, fire-and-forget).
   */
  dragOut(paths: string[]): void;
  startCursorWatcher(): void;
  stopCursorWatcher(): void;
  onCursorEnter(cb: () => void): () => void;
  onCursorLeave(cb: () => void): () => void;
}

export interface XplorerApi
  extends FsApi, SystemApi, WatchApi, MediaApi, DndApi, MenuApi, LaunchApi
{}

declare global {
  interface Window {
    xplorer: XplorerApi;
  }
}
