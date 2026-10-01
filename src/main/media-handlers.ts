import { Queue } from "async-await-queue";
import { app, ipcMain } from "electron";
import ffmpeg from "fluent-ffmpeg";
import { lookup } from "mrmime";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import sharp, { Sharp } from "sharp";
import { handle } from "./ipc";
import { handleXmediaProtocol, xmediaUrl } from "./media-protocol";
import { getMainPlatform } from "./platform";

const exe = (name: string) =>
  process.platform === "win32" ? `${name}.exe` : name;

export function setupFfmpeg() {
  if (app.isPackaged) {
    ffmpeg.setFfmpegPath(path.join(process.resourcesPath, exe("ffmpeg")));
    ffmpeg.setFfprobePath(path.join(process.resourcesPath, exe("ffprobe")));
  } else {
    ffmpeg.setFfmpegPath(require("ffmpeg-static"));
    ffmpeg.setFfprobePath(require("ffprobe-static").path);
  }
}

/**
 * Media IPC handlers ("media:*" channels): streaming media URLs, disk-cached
 * thumbnails and the renderer-side thumbnail persist call.
 *
 * Thumbnail strategy:
 *  1. Raster images decodable by Electron's `nativeImage` (PNG/JPEG/BMP and
 *     friends) are generated in the main process and cached as PNG files.
 *  2. Formats `nativeImage` cannot decode (GIF, WebP, AVIF, SVG) and video
 *     files return `null`, in which case the renderer generates the
 *     thumbnail with a canvas (see `src/renderer/media-thumbs.ts`) and
 *     pushes the result back through `media:cacheThumbnail`, so the same
 *     disk cache is shared by both paths.
 *  3. Cache keys are a SHA-256 of `path:mtimeMs:size`, so entries
 *     automatically invalidate when a file changes on disk.
 */

const MEDIA_CACHE_DIR = "thumbnails";

/** Longest side of a generated thumbnail, in pixels. */
const THUMBNAIL_MAX_DIMENSION = 384;

/** Registers all media handlers. Call once during app startup. */
export function registerMediaHandlers(): void {
  handleXmediaProtocol();
  handle("media:getThumbnail", ["path"], getThumbnail);
  handle("media:getMediaUrl", ["path"], getMediaUrl);
  // (path, dataUrl) doesn't fit ipc.ts's path-only arg specs, so this channel
  // is registered with plain `ipcMain.handle` and validates its own args.
  ipcMain.handle(
    "media:cacheThumbnail",
    (_event, p: unknown, dataUrl: unknown) => cacheThumbnail(p, dataUrl),
  );
}

/** Full-size streaming URL for the preview pane / media elements. */
async function getMediaUrl(p: string): Promise<string> {
  const st = await fsp.stat(p);
  if (!st.isFile()) {
    throw new Error(`media:getMediaUrl: not a regular file: "${p}"`);
  }
  return xmediaUrl(p);
}

const ThumbResolverQueue = new Queue(8);

/**
 * Small thumbnail for gallery/list views and the preview pane, or `null`
 * when the renderer should try the canvas fallback (or no thumbnail is
 * possible at all).
 */
async function getThumbnail(p: string): Promise<string | null> {
  return ThumbResolverQueue.run(async () => {
    let st: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      st = await fsp.stat(p);
    } catch (err) {
      console.error(err);
      return null;
    }
    if (!st.isFile()) {
      return null;
    }

    const mimetype = lookup(path.extname(p).toLowerCase());
    if (
      !mimetype
      || !(mimetype.startsWith("image/") || mimetype.startsWith("video/"))
    ) {
      return null;
    }

    // mrmime maps `.ts` to `video/mp2t` (MPEG transport stream), so TypeScript
    // source files pass the image/video check above and would otherwise fall
    // through to the renderer's canvas video-thumbnail path, burning a doomed
    // 4s load attempt per file. Skip them up front (mirrored in
    // src/renderer/media-thumbs.ts).
    if (mimetype === "video/mp2t") {
      return null;
    }

    const cacheFile = cachePathFor(p, st);

    // Cache hit: serve the stored PNG directly, no generation at all.
    try {
      await fsp.access(cacheFile);
      return xmediaUrl(cacheFile);
    } catch (err) {
      console.error(err);
      // fall through to generation
    }

    if (mimetype === "image/svg+xml") {
      // Deliberately not rasterized by nativeImage: SVG scales losslessly, so
      // the renderer either serves the file itself or rasterizes via canvas.
      return null;
    }

    try {
      if (mimetype.startsWith("video/")) {
        await extractFrame(p, cacheFile);
      } else {
        const img = sharp(p);

        const webp = resizeToFit(img).webp({ effort: 2, quality: 60 });
        await fsp.mkdir(thumbnailDir(), { recursive: true });
        await webp.toFile(cacheFile);
      }
    } catch (err) {
      console.error("media:getThumbnail: failed to store cache entry", p, err);
      return null;
    }
    return xmediaUrl(cacheFile);
  });
}

function extractFrame(videoPath: string, outname: string) {
  return new Promise((resolve, reject) => {
    setupFfmpeg();
    ffmpeg(videoPath)
      .on("end", () => resolve(outname))
      .on("error", reject)
      .screenshots({
        timestamps: [1], // seconds, '00:00:05', or '50%' (needs ffprobe)
        filename: path.basename(outname),
        folder: path.dirname(outname),
        size: `${THUMBNAIL_MAX_DIMENSION}x?`, // optional; '?' keeps aspect ratio
      });
  });
}

/**
 * Persists a renderer-generated canvas thumbnail (a `data:image/*;base64`
 * URL) into the same disk cache used by the main-process generator.
 * Returns the cache file's `xmedia://` URL, or `""` on any failure.
 */
async function cacheThumbnail(p: unknown, dataUrl: unknown): Promise<string> {
  try {
    if (
      typeof p !== "string"
      || p.length === 0
      || p.includes("\0")
      || !getMainPlatform().isValidAbsolutePath(p)
    ) {
      return "";
    }
    if (typeof dataUrl !== "string") return "";

    const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(
      dataUrl,
    );
    if (!match) return "";

    const st = await fsp.stat(p);
    if (!st.isFile()) return "";

    const cacheFile = cachePathFor(p, st);
    await fsp.mkdir(thumbnailDir(), { recursive: true });
    await fsp.writeFile(cacheFile, Buffer.from(match[1], "base64"));
    return xmediaUrl(cacheFile);
  } catch (err) {
    console.error("media:cacheThumbnail failed", err);
    return "";
  }
}

// ─── Cache helpers ───────────────────────────────────────────────────────────

/** `userData/thumbnails` - the on-disk thumbnail cache directory. */
function thumbnailDir(): string {
  return path.join(app.getPath("userData"), MEDIA_CACHE_DIR);
}

/**
 * Cache file for a given file state: `<sha256(path:mtimeMs:size)>.png`.
 * The file stat is baked into the key, so editing/moving/replacing a file
 * invalidates its thumbnail without any explicit eviction.
 */
function cachePathFor(
  p: string,
  st: { mtimeMs: number; size: number },
): string {
  const key = crypto
    .createHash("sha256")
    .update(`${p}:${st.mtimeMs}:${st.size}`)
    .digest("hex");
  return path.join(thumbnailDir(), `${key}.webp`);
}

/** Downscales the image so its longest side fits `THUMBNAIL_MAX_DIMENSION`. */
function resizeToFit(image: Sharp): Sharp {
  return image.resize({
    width: THUMBNAIL_MAX_DIMENSION,
    height: THUMBNAIL_MAX_DIMENSION,
    withoutEnlargement: true,
    fit: "inside",
  });
}
