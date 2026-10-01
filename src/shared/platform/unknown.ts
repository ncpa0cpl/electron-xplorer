import path from "path-browserify";
import type { Platform } from "./types";

/**
 * Degraded defaults for a platform received from an untrusted/newer main
 * process (or a platform the renderer has no implementation for).
 *
 * Conservative on purpose:
 *  - POSIX-style paths (the least surprising across exotic platforms),
 *  - NO hidden files at all (never guess),
 *  - every operation must be crash-free on arbitrary input.
 */

export function createUnknownPlatform(): Platform {
  return {
    id: "unknown",
    paths: {
      isAbsolute: (p) => path.isAbsolute(p),
      join: (...segments) => path.join(...segments),
      dirname: (p) => path.dirname(p),
      basename: (p) => path.basename(p),
      normalize: (p) => path.normalize(p),
    },
    files: {
      // Never guess: hide nothing on an unknown platform.
      isHiddenName: () => false,
    },
  };
}
