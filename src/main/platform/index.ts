import { DarwinPlatform } from "./darwin";
import { LinuxPlatform } from "./linux";
import type { MainPlatform } from "./types";
import { UnknownPlatform } from "./unknown";
import { Win32Platform } from "./win32";

/**
 * THE ONE-SWITCH RULE (maintainer-mandated): this factory contains the only
 * `process.platform` conditional in the codebase. Every other main-process
 * call site reads `getMainPlatform().doStuff()` and never branches on the
 * platform. (The renderer's equivalent factory is `createPlatform(id)` in
 * src/shared/platform/types.ts, switched on the platform id it receives from
 * the main process.)
 *
 * All four platform classes are imported eagerly; their module scopes only
 * declare constants (no side effects, no assumptions about the host), so it
 * is safe to load them all on any platform and switch at runtime. The
 * `cached: MainPlatform` assignments below are what type-check the classes'
 * MainPlatform conformance.
 */

let cached: MainPlatform | undefined;

/** Returns the main platform implementation for the running OS. */
export function getMainPlatform(): MainPlatform {
  if (cached === undefined) {
    switch (process.platform) {
      case "linux":
        cached = LinuxPlatform;
        break;
      case "darwin":
        cached = DarwinPlatform;
        break;
      case "win32":
        cached = Win32Platform;
        break;
      default:
        cached = UnknownPlatform;
        break;
    }
  }
  return cached;
}
