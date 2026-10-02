import { ipcRenderer } from "electron";
import type { PlaceInfo, SystemApi } from "../shared/fs-types";
import type { PlatformId } from "../shared/platform/types";

/**
 * Preload-side system operations. Each function maps 1:1 to a "system:*" IPC
 * channel registered in `src/main/system-handlers.ts`.
 */
export const systemApi: SystemApi = {
  getHomeDir: () => ipcRenderer.invoke("system:getHomeDir") as Promise<string>,
  getStaticPlaces: () =>
    ipcRenderer.invoke("system:getStaticPlaces") as Promise<PlaceInfo[]>,
  openPath: (p) => ipcRenderer.invoke("system:openPath", p) as Promise<void>,
  openInTerminal: (p) =>
    ipcRenderer.invoke("system:openInTerminal", p) as Promise<void>,
  openWith: (p) => ipcRenderer.invoke("system:openWith", p) as Promise<void>,
  getPlatformInfo: () =>
    ipcRenderer.invoke("system:getPlatformInfo") as Promise<PlatformId>,
  // Registered on the "fs:trash" channel by src/main/fs-handlers.ts.
  trash: (p) => ipcRenderer.invoke("fs:trash", p) as Promise<void>,
  // Permanent delete: reuses the existing "fs:remove" channel, bypassing trash.
  removePermanent: (p) => ipcRenderer.invoke("fs:remove", p) as Promise<void>,
  setWindowTitle: (title) =>
    ipcRenderer.invoke("system:setWindowTitle", title) as Promise<void>,
};
