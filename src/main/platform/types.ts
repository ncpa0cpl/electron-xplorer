import type { PlaceInfo } from "../../shared/fs-types";
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
  /** Opens the platform's terminal emulator in the given directory. */
  openInTerminal(dir: string): Promise<void>;
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
