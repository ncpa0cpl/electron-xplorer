import type {
  PlaceInfo,
  TrashEntryInfo,
  TrashRestoreItem,
} from "../../shared/fs-types";
import type { PlatformId } from "../../shared/platform/types";

/**
 * Main-process platform behavior. Every platform-dependent operation the
 * main process performs is expressed as a method on this interface; call
 * sites always read `getMainPlatform().doStuff()` and never branch on
 * `process.platform` themselves (the only allowed switch lives in
 * src/main/platform/index.ts).
 */
export interface MainPlatform {
  readonly id: PlatformId;
  /** Well-known left-pane places (existence-filtered). */
  getStaticPlaces(): Promise<PlaceInfo[]>;
  /**
   * Opens a FILE with its default application: on darwin the app last picked
   * via `openWithDialog` for the file's extension (when still installed),
   * otherwise the OS default. Rejects with the launch error description.
   */
  openPath(p: string): Promise<void>;
  /** Opens the platform's terminal emulator in the given directory. */
  openInTerminal(dir: string): Promise<void>;
  /**
   * Summons the OS-native "choose application" ("Open With") dialog for the
   * given FILE. Resolution is left entirely to the OS: this method only has
   * to make the dialog appear, and resolves once the dialog has been
   * successfully summoned (user cancellation inside the dialog is not an
   * error and is not reported back).
   */
  openWithDialog(p: string): Promise<void>;
  /** True if the string is a valid absolute native path for this platform. */
  isValidAbsolutePath(p: string): boolean;
  /**
   * Converts a decoded `xmedia://` URL path (see src/main/media-protocol.ts)
   * into a native absolute filesystem path. POSIX platforms use the identity
   * (the URL path IS the native path); win32 strips the single leading "/"
   * that the empty-authority URL form inserts before a drive letter
   * (`xmedia:///C:/...` → `C:/...`).
   */
  protocolPathToAbsolute(decodedUrlPath: string): string;
  /**
   * Menu accelerator for a logical key, e.g. "new-tab" → "Ctrl+T" (win32 /
   * linux) or "CmdOrCtrl+T" (darwin, where Electron maps it to Cmd).
   */
  accelerator(key: MenuAcceleratorKey): string;
  /** Whether the platform expects an app menu as the first menu (darwin). */
  usesAppMenu(): boolean;
  /**
   * Whether the app should quit when its last window closes. False on darwin,
   * where the conventional behavior is to keep running with no windows until
   * the user quits explicitly (see src/main/index.ts).
   */
  quitAfterAllWindowsClosed(): boolean;
  /** Lists the OS trash contents (see src/main/platform/trash-common.ts). */
  listTrash(): Promise<TrashEntryInfo[]>;
  /**
   * Restores trashed items to their original locations. Items whose original
   * location is not known are rejected (aggregated into one error).
   */
  restoreTrash(items: ReadonlyArray<TrashRestoreItem>): Promise<void>;
  /**
   * Permanently deletes EVERY item in the platform's trash (unrecoverable;
   * the renderer asks for confirmation before calling this). Per-item
   * best-effort: failures are collected and rejected as one aggregated
   * error (same style as `restoreTrash`). A missing trash is already empty.
   */
  emptyTrash(): Promise<void>;
  /**
   * BrowserWindow options for the custom integrated titlebar
   * (src/renderer/titlebar.ts): darwin keeps the NATIVE traffic lights at
   * their default top-left position by hiding only the native title bar
   * (`titleBarStyle: "hidden"`); every other platform drops the native frame
   * entirely (`frame: false`) and gets custom window-control buttons on the
   * titlebar's right side.
   */
  titlebarWindowOptions(): TitlebarWindowOptions;
}

/** BrowserWindow options that switch on the integrated-titlebar mode. */
export interface TitlebarWindowOptions {
  readonly frame?: boolean;
  readonly titleBarStyle?: "hidden";
}

/** Logical accelerator keys the app menu uses. */
export type MenuAcceleratorKey =
  | "new-tab"
  | "close-tab"
  | "refresh"
  | "back"
  | "forward"
  | "up"
  | "home";
