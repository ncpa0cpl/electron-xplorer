import { ipcRenderer } from "electron";
import type { MediaApi } from "../shared/media-types";

/**
 * Preload-side media operations. Each function maps 1:1 to a "media:*" IPC
 * channel registered in `src/main/media-handlers.ts`.
 */
export const mediaApi: MediaApi = {
  getMediaUrl: (p) =>
    ipcRenderer.invoke("media:getMediaUrl", p) as Promise<string>,
  getThumbnail: (p) =>
    ipcRenderer.invoke("media:getThumbnail", p) as Promise<string | null>,
  cacheThumbnail: (p, dataUrl) =>
    ipcRenderer.invoke("media:cacheThumbnail", p, dataUrl) as Promise<string>,
};
