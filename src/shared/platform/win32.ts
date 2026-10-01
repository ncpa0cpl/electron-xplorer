import type { Platform } from "./types";

/**
 * Windows path handling (shared, pure JS, dependency-free).
 *
 * Canonical OUTPUT format uses FORWARD slashes: `C:/Users/me/file.txt`.
 *
 * Why (documented decision): fs-explorer's internal `Path` class parses
 * path strings POSIX-style (it splits on "/" only), and every Node/Electron
 * filesystem API on Windows (`fs.*`, `shell.openPath`, spawn `cwd`, ...)
 * accepts forward slashes. Backslashes are accepted on INPUT and normalized
 * away, so the app deals with exactly one canonical string form everywhere
 * (renderer, IPC, main, watchers).
 *
 * Accepted input forms: drive paths (`C:\foo`, `C:/foo`), UNC paths
 * (`\\server\share\x`, `//server/share/x`), and relative paths. Both
 * separators may be mixed freely within one path.
 *
 * Deliberate semantics (documented deviations from node:path.win32):
 *  - `isAbsolute` is true only for drive-rooted (`C:\...`, `C:/...`) and UNC
 *    paths. Rooted-but-drive-less (`\foo`, `/foo`) and drive-relative
 *    (`C:foo`) forms depend on per-process state the renderer cannot know,
 *    so they are treated as NOT absolute; the app never produces them.
 *  - Drive-relative paths keep their device (`dirname("C:foo")` → `"C:"`,
 *    where node returns `"C:."`); they never appear in app data flows.
 *  - UNC root output has no trailing separator (`normalize("//s/share/")`
 *    → `//s/share`; node keeps one).
 *  - Not supported (never produced by the app): device paths (`\\.\`,
 *    `\\?\`) and NTFS alternate-data-stream suffixes (`:stream`).
 *
 * Hidden files: Windows' real hidden attribute is a filesystem flag that
 * Node's fs does not expose, so `isHiddenName` is a pragmatic NAME-BASED
 * approximation listing well-known system/OS artifacts. Documented as an
 * approximation, matched case-insensitively (NTFS is case-insensitive).
 */

/** Drive-rooted: `C:\` or `C:/` (both separators accepted on input). */
const DRIVE_ROOT_RE = /^[a-zA-Z]:[\\/]/;
/** UNC: `\\server\share` or `//server/share` (host + share required). */
const UNC_RE = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/;
/** Drive prefix, with or without a following root separator. */
const DRIVE_PREFIX_RE = /^([a-zA-Z]):([\\/]?)/;
/** Canonical hidden-by-name list (see module doc block). */
const HIDDEN_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "desktop.ini",
  "thumbs.db",
  "pagefile.sys",
  "hiberfil.sys",
  "swapfile.sys",
  "appdata",
]);
/** Anything named `ntuser.dat*` (registry hives and their transactions). */
const HIDDEN_NAME_PREFIXES = ["ntuser.dat"];

interface ParsedPath {
  /** `""` for relative paths, `"C:"` for a drive, `"//server/share"` for UNC. */
  device: string;
  /** `true` when a root separator follows the device (or leads the path). */
  rooted: boolean;
  /** Non-empty raw segments (dots and dot-dots included). */
  parts: string[];
}

/** Splits a path into device/root/segments. Accepts both separators. */
function splitPath(p: string): ParsedPath {
  const unc = UNC_RE.exec(p);
  if (unc) {
    // Canonical UNC device: exactly two leading slashes, then host and share
    // separated by one forward slash each ("\\SERVER\share" → "//SERVER/share").
    const body = p
      .slice(0, unc[0].length)
      .replace(/^[\\/]+/, "")
      .replace(/[\\/]+/g, "/");
    const device = `//${body}`;
    const rest = p.slice(unc[0].length);
    return { device, rooted: true, parts: splitParts(rest) };
  }

  const drive = DRIVE_PREFIX_RE.exec(p);
  if (drive) {
    const device = `${drive[1]}:`;
    const rooted = drive[2] !== "";
    return { device, rooted, parts: splitParts(p.slice(drive[0].length)) };
  }

  // Rooted relative ("\foo" or "/foo") or plain relative path.
  return {
    device: "",
    rooted: p.startsWith("/") || p.startsWith("\\"),
    parts: splitParts(p),
  };
}

/** Splits a path chunk into non-empty segments on both separators. */
function splitParts(p: string): string[] {
  return p.split(/[\\/]+/).filter((part) => part.length > 0);
}

/** Applies "." / ".." resolution; `..` at a root stays at the root. */
function resolveDots(parts: string[], rooted: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!rooted) {
        out.push("..");
      }
      // Rooted: ".." at the root is a no-op (stay at the root).
    } else {
      out.push(part);
    }
  }
  return out;
}

/** Reassembles a parsed path into the canonical forward-slash form. */
function format(device: string, rooted: boolean, parts: string[]): string {
  if (parts.length === 0) {
    // Root forms: `C:\` → `C:/`, UNC root → `//server/share`, `/` → `/`.
    return device === ""
      ? (rooted ? "/" : "")
      : device + (rooted && !device.startsWith("//") ? "/" : "");
  }
  const head = device + (rooted ? "/" : device === "" ? "" : "/");
  return head + parts.join("/");
}

export function createWin32Platform(): Platform {
  return {
    id: "win32",
    paths: {
      isAbsolute(p) {
        return DRIVE_ROOT_RE.test(p) || UNC_RE.test(p);
      },
      join(...segments) {
        const nonEmpty = segments.filter((s) => s.length > 0);
        if (nonEmpty.length === 0) {
          return "";
        }
        const { device, rooted, parts } = splitPath(nonEmpty[0]);
        for (const segment of nonEmpty.slice(1)) {
          parts.push(...splitParts(segment));
        }
        return format(device, rooted, resolveDots(parts, rooted));
      },
      dirname(p) {
        const { device, rooted, parts } = splitPath(p);
        if (parts.length === 0) {
          // Already at (or below) the root.
          if (rooted) {
            return format(device, true, []);
          }
          // Drive-relative ("C:") or plain relative ("") input.
          return device === "" ? "." : device;
        }
        const parent = parts.slice(0, -1);
        if (parent.length === 0) {
          // The parent IS the root.
          if (device !== "") {
            return format(device, rooted, []);
          }
          return rooted ? "/" : ".";
        }
        return format(device, rooted, parent);
      },
      basename(p) {
        const { parts } = splitPath(p);
        return parts.length === 0 ? "" : parts[parts.length - 1];
      },
      normalize(p) {
        if (p === "") {
          return ".";
        }
        const { device, rooted, parts } = splitPath(p);
        const out = format(device, rooted, resolveDots(parts, rooted));
        return out === "" ? "." : out;
      },
    },
    files: {
      isHiddenName(name) {
        const lower = name.toLowerCase();
        return HIDDEN_NAMES.has(lower)
          || HIDDEN_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix));
      },
    },
  };
}
