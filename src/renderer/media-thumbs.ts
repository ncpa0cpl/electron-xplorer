import { lookup } from "mrmime";
import { rendererPlatform } from "./platform";

/**
 * Renderer-side canvas thumbnail fallback.
 *
 * Used for the formats the main process cannot thumbnail with `nativeImage`:
 * video files (no ffmpeg in the build) and image codecs `nativeImage` can't
 * decode (GIF, WebP, AVIF, SVG...). The generated data URL is sent back to
 * the main process (`media:cacheThumbnail`) so the thumbnail is generated
 * only once per file version and served from the disk cache afterwards.
 *
 * Media is fetched from its `xmedia://` streaming URL and re-wrapped in a
 * blob URL before it touches a canvas - blob URLs are same-origin, so the
 * canvas stays untainted and `toDataURL` is allowed.
 */

/** Same cap as the main process - oversized files never get thumbnails. */
const MAX_INPUT_SIZE = 80 * 1024 * 1024;

/** Hard deadline for loading + seeking + drawing. */
const TIMEOUT_MS = 4000;

/** Longest side of a generated thumbnail (matches the main-process cache). */
const MAX_DIMENSION = 384;

/**
 * Generates a canvas-based thumbnail for `filePath`, or `null` on any
 * failure/timeout/non-media file.
 */
export async function generateCanvasThumbnail(
  filePath: string,
): Promise<string | null> {
  try {
    // Platform-aware basename (POSIX separators on linux/macOS; the win32
    // platform accepts both separators on input).
    const mimetype = lookup(
      rendererPlatform().paths.basename(filePath).toLowerCase(),
    );
    if (!mimetype) return null;
    if (!(mimetype.startsWith("image/") || mimetype.startsWith("video/"))) {
      return null;
    }

    // mrmime maps `.ts` to `video/mp2t` (MPEG transport stream), so
    // TypeScript files would reach the video path below and burn a doomed 4s
    // <video> load attempt each. Skip them fast (mirrored in
    // src/main/media-handlers.ts).
    if (mimetype === "video/mp2t") return null;

    const entry = await window.xplorer.stat(filePath);
    if (entry.isDirectory || entry.size > MAX_INPUT_SIZE) {
      return null;
    }

    // Streaming URL - only the needed byte ranges are read from disk.
    const src = await window.xplorer.getMediaUrl(filePath);
    const blobUrl = await fetchAsBlobUrl(src);
    try {
      return mimetype.startsWith("video/")
        ? await videoThumbnail(blobUrl)
        : await imageThumbnail(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (err) {
    console.error("canvas thumbnail generation failed", filePath, err);
    return null;
  }
}

/** `fetch`es the media and returns a same-origin blob URL for it. */
async function fetchAsBlobUrl(src: string): Promise<string> {
  const response = await withTimeout(fetch(src));
  if (!response.ok) {
    throw new Error(`xmedia fetch failed: ${response.status}`);
  }
  return URL.createObjectURL(await response.blob());
}

/** Draws the first usable frame of a video (~1s or 10% in) to a JPEG data URL. */
async function videoThumbnail(src: string): Promise<string | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  try {
    await withTimeout(loadMedia(video, src));

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const seekTo = duration > 0 ? Math.min(1, duration * 0.1) : 1;
    await withTimeout(seekVideo(video, seekTo));
    if (video.videoWidth === 0) return null;

    const { canvas, ctx } = scaledCanvas(video.videoWidth, video.videoHeight);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/** Draws an image (including SVG, which browsers rasterize on draw) to a PNG data URL. */
async function imageThumbnail(src: string): Promise<string | null> {
  const img = new Image();
  await withTimeout(loadImage(img, src));
  if (!img.naturalWidth) return null;

  const { canvas, ctx } = scaledCanvas(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/** Canvas sized so the longest side fits `MAX_DIMENSION`, aspect preserved. */
function scaledCanvas(
  sourceWidth: number,
  sourceHeight: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const scale = Math.min(
    1,
    MAX_DIMENSION / Math.max(sourceWidth, sourceHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  return { canvas, ctx: canvas.getContext("2d")! };
}

/** Resolves on `loadedmetadata`/`canplay`, rejects on element error. */
function loadMedia(
  el: HTMLImageElement | HTMLVideoElement,
  src: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      el.removeEventListener("loadedmetadata", onOk);
      el.removeEventListener("canplay", onOk);
      el.removeEventListener("error", onErr);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("media load failed"));
    };
    el.addEventListener("loadedmetadata", onOk, { once: true });
    el.addEventListener("canplay", onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
    el.src = src;
  });
}

/** Resolves on `load`, rejects on element error (images don't fire media events). */
function loadImage(img: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      img.removeEventListener("load", onOk);
      img.removeEventListener("error", onErr);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("image load failed"));
    };
    img.addEventListener("load", onOk, { once: true });
    img.addEventListener("error", onErr, { once: true });
    img.src = src;
  });
}

/** Resolves on `seeked`, rejects on element error. */
function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("video seek failed"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onErr, { once: true });
    video.currentTime = time;
  });
}

/** Rejects if `promise` doesn't settle within `TIMEOUT_MS`. */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
