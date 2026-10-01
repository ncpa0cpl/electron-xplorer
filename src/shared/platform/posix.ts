import path from "path-browserify";
import type { Platform, PlatformId } from "./types";

/**
 * POSIX path handling (linux AND darwin) and the POSIX hidden-file rule.
 *
 * Delegates to path-browserify (pure JS, already a dependency), which is
 * importable from both the main and renderer bundles, so both processes get
 * byte-identical path semantics.
 */

/** Names that the POSIX convention treats as hidden: dot files. */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

export function createPosixPlatform(id: PlatformId): Platform {
  return {
    id,
    paths: {
      isAbsolute: (p) => path.isAbsolute(p),
      join: (...segments) => path.join(...segments),
      dirname: (p) => path.dirname(p),
      basename: (p) => path.basename(p),
      normalize: (p) => path.normalize(p),
    },
    files: { isHiddenName },
  };
}
