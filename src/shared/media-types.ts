/**
 * Media (thumbnail / preview streaming) types. Owned by the media chunk.
 */
export interface MediaApi {
  /**
   * Returns a URL usable as `img`/`video` `src` for previewing the given
   * media file: a custom-protocol streaming URL (`xmedia://`) with full
   * Range support.
   */
  getMediaUrl(path: string): Promise<string>;
  /**
   * Returns a small thumbnail (custom-protocol URL or data URL) for the
   * given file, or `null` when no thumbnail could be produced (the caller
   * may then try the renderer-side canvas fallback).
   */
  getThumbnail(path: string): Promise<string | null>;
  /**
   * Persists a renderer-generated thumbnail (`data:image/*;base64` URL) into
   * the main process's thumbnail disk cache. Returns the cache file's
   * `xmedia://` URL, or `""` when the entry could not be stored.
   */
  cacheThumbnail(path: string, dataUrl: string): Promise<string>;
}
