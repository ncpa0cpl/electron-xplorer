import { app, protocol } from "electron";
import { lookup } from "mrmime";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getMainPlatform } from "./platform";

/**
 * The `xmedia` scheme: streams files from the real filesystem to the renderer
 * over a custom privileged protocol.
 *
 * URL form: `xmedia://` + the absolute filesystem path, split on "/" and
 * percent-encoded per segment, e.g.
 *  - POSIX:  `xmedia:///home/owner/My Pictures/a.png`
 *  - win32:  `xmedia:///C:/Users/me/My Pictures/a.png` (the app's canonical
 *    forward-slash form; the empty authority contributes one leading "/" so
 *    the decoded path arrives as `/C:/...`, which the main platform bridge
 *    strips back to `C:/...` - see `protocolPathToAbsolute`).
 *
 * The handler implements full HTTP Range support (206 Partial Content) so
 * that `<video>` elements can seek and large media never has to be loaded
 * into memory as a whole.
 */

const SCHEME = "xmedia";

/**
 * Registers `xmedia` as a privileged scheme. MUST be called before the app
 * `ready` event (Chromium locks the scheme registry afterwards).
 */
export function registerXmediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        /** Enables range requests / seeking for media elements. */
        stream: true,
        /** Lets the renderer `fetch()` from this scheme (canvas thumbnails). */
        supportFetchAPI: true,
        /**
         * Makes `fetch()` (CORS-mode by default) and CORS-clean image/video
         * loads possible, so renderer-side canvas thumbnails don't taint
         * the canvas. The handler always answers with
         * `Access-Control-Allow-Origin: *`.
         */
        corsEnabled: true,
      },
    },
  ]);
}

/** Builds an `xmedia://` URL for an absolute filesystem path.
 *
 * Paths arrive in the app's canonical form: POSIX paths as-is, win32 paths
 * forward-slashed (`C:/Users/...`), so a plain segment split on "/" covers
 * both platforms (percent-encoding makes each segment URL-safe).
 */
export function xmediaUrl(filePath: string): string {
  return `${SCHEME}://${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

/** Registers the protocol handler. Call once during app startup. */
export function handleXmediaProtocol(): void {
  // `protocol.handle` may only be called once the app is ready; callers
  // register handlers during startup, so defer if needed.
  const register = () => {
    protocol.handle(SCHEME, (request) => {
      return serve(request).catch((err) => {
        console.error("[xmedia] failed to serve", request.url, err);
        return new Response("Internal error", { status: 500 });
      });
    });
  };
  if (app.isReady()) {
    register();
  } else {
    void app.whenReady().then(register);
  }
}

async function serve(request: Request): Promise<Response> {
  let filePath: string;
  try {
    filePath = parseXmediaUrl(request.url);
  } catch (err) {
    console.error("[xmedia] rejected url", request.url, err);
    return new Response("Bad request", { status: 400 });
  }

  let st: fs.Stats;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!st.isFile()) {
    return new Response("Not found", { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": lookup(path.extname(filePath))
      ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    // The renderer fetches/draws media onto canvases for thumbnails; a
    // permissive ACAO (paired with `corsEnabled: true`) keeps those canvases
    // untainted. This only exposes files the app already has full access to.
    "Access-Control-Allow-Origin": "*",
  };

  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseRange(rangeHeader, st.size) : null;

  // A `Range` header was present but unsatisfiable (RFC 7233 -> 416).
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${st.size}` },
    });
  }

  // Empty files have no readable byte range; serve an empty 200/206 directly.
  if (st.size === 0) {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const { start, end } = range ?? { start: 0, end: st.size - 1 };
  if (range) {
    headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  }
  headers["Content-Length"] = String(end - start + 1);

  const nodeStream = fs.createReadStream(filePath, { start, end });
  request.signal.addEventListener("abort", () => {
    nodeStream.destroy();
  });

  // Hand Chromium a web ReadableStream; only the requested byte slice is
  // ever read from disk.
  return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  });
}

/**
 * Extracts the absolute filesystem path from an `xmedia://` URL.
 * Requires the decoded path to be absolute and free of null bytes; the
 * absolute-path form is platform-specific and handled by the main platform
 * bridge (win32 additionally strips the leading "/" of the empty-authority
 * URL form before a drive letter).
 */
function parseXmediaUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`unparseable URL "${rawUrl}"`);
  }
  if (url.protocol !== `${SCHEME}:`) {
    throw new Error(`wrong protocol "${url.protocol}"`);
  }
  // Our URLs always use an empty authority (`xmedia:///abs/path`); anything
  // claiming a host other than the implicit "localhost" form is rejected.
  if (url.host !== "" && url.host !== "localhost") {
    throw new Error(`unexpected host "${url.host}"`);
  }

  const decoded = decodeURIComponent(url.pathname);
  if (decoded.includes("\0")) {
    throw new Error("path contains a null byte");
  }
  return getMainPlatform().protocolPathToAbsolute(decoded);
}

/**
 * Parses a `bytes=start-end` / `bytes=-suffix` / `bytes=start-` range header
 * against a file of the given size. Returns `null` when the range is
 * malformed or unsatisfiable.
 */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const suffix = Number.parseInt(rawEnd, 10);
    if (suffix === 0) return null;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (start >= size) return null;

  if (rawEnd === "") {
    return { start, end: size - 1 };
  }
  // Clamp an oversized end to the last byte (RFC 7233).
  const end = Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (start > end) return null;
  return { start, end };
}
