import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PlaceInfo } from "../../shared/fs-types";

/**
 * Helpers shared by the POSIX main platforms (linux, darwin): building the
 * well-known left-pane places from the user's home directory, filtering to
 * directories that actually exist.
 */

/** One well-known place, relative to the user's home directory. */
export interface HomeSubdirCandidate {
  readonly label: string;
  /** Path relative to home ("" = home itself); absolute paths pass through. */
  readonly subpath: string;
}

/**
 * Builds `{ id, label, path }` places for the candidates that exist as
 * directories. Missing candidates (an OS/user without XDG dirs, say) are
 * silently skipped; the shape matches fs-explorer's `Place` interface.
 */
export async function homeSubdirPlaces(
  candidates: readonly HomeSubdirCandidate[],
): Promise<PlaceInfo[]> {
  const home = os.homedir();
  const places: PlaceInfo[] = [];
  for (const { label, subpath } of candidates) {
    const p = subpath === "" ? home : path.join(home, subpath);
    if (await isDirectory(p)) {
      places.push({ id: placeId(label), label, path: p });
    }
  }
  return places;
}

/** `true` if `p` exists and is a directory. */
export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Stable id for a place label (`"My Place"` → `"static-my-place"`). */
export function placeId(label: string): string {
  return `static-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
