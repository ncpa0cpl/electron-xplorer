import { ipcRenderer } from "electron";
import type { DirEntry, FsApi } from "../shared/fs-types";

/**
 * Preload-side file operations. Each function maps 1:1 to an "fs:*" IPC
 * channel registered in `src/main/fs-handlers.ts`.
 */
export const fsApi: FsApi = {
  readdirStat: (dir) =>
    ipcRenderer.invoke("fs:readdirStat", dir) as Promise<DirEntry[]>,
  stat: (p) => ipcRenderer.invoke("fs:stat", p) as Promise<DirEntry>,
  exists: (p) => ipcRenderer.invoke("fs:exists", p) as Promise<boolean>,
  dirExists: (p) => ipcRenderer.invoke("fs:dirExists", p) as Promise<boolean>,
  copy: (from, to) => ipcRenderer.invoke("fs:copy", from, to) as Promise<void>,
  move: (from, to) => ipcRenderer.invoke("fs:move", from, to) as Promise<void>,
  remove: (p) => ipcRenderer.invoke("fs:remove", p) as Promise<void>,
  mkdir: (p) => ipcRenderer.invoke("fs:mkdir", p) as Promise<void>,
  touch: (p) => ipcRenderer.invoke("fs:touch", p) as Promise<void>,
  readFile: (p) => ipcRenderer.invoke("fs:readFile", p) as Promise<Uint8Array>,
};
