/**
 * Shared, host-independent platform behavior (main AND renderer).
 *
 * Zero Node/Electron imports: this module must stay importable from the
 * renderer bundle and the main bundle alike. All platform-dependent logic in
 * the codebase lives behind `Platform` (shared, pure path/hidden-file
 * behavior) or `MainPlatform` (src/main/platform - process-level behavior).
 *
 * THE ONE-SWITCH RULE (maintainer-mandated): the only platform-conditional
 * code in the codebase is
 *  - this factory's `switch (id)`, and
 *  - `getMainPlatform()`'s `switch (process.platform)` in src/main/platform.
 * Call sites never branch on the platform; they call `platform.doStuff()`.
 */

/** Identifiers for the platforms the app supports. */
export type PlatformId = "linux" | "darwin" | "win32" | "unknown";

/** Pure, host-independent platform behavior. */
export interface Platform {
  readonly id: PlatformId;
  /** Path segment handling for the platform's native path format. */
  readonly paths: {
    isAbsolute(p: string): boolean;
    join(...segments: string[]): string;
    dirname(p: string): string;
    basename(p: string): string;
    normalize(p: string): string;
  };
  /** File-hiding conventions. */
  readonly files: {
    /** Name-based approximation of the platform's hidden-file rule. */
    isHiddenName(name: string): boolean;
  };
}

import { createPosixPlatform } from "./posix";
import { createUnknownPlatform } from "./unknown";
import { createWin32Platform } from "./win32";

/**
 * Builds the `Platform` implementation for `id`.
 *
 * This switch is the renderer-side factory: the renderer receives the
 * `PlatformId` from the main process ("system:getPlatformInfo") and must
 * never branch on it anywhere else.
 */
export function createPlatform(id: PlatformId): Platform {
  switch (id) {
    case "linux":
    case "darwin":
      // linux and darwin share the POSIX path/hidden-file conventions.
      return createPosixPlatform(id);
    case "win32":
      return createWin32Platform();
    case "unknown":
      return createUnknownPlatform();
  }
}
