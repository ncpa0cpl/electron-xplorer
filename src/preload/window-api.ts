import { ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { WindowApi } from "../shared/fs-types";

/**
 * Preload-side window-control bridge for the custom integrated titlebar
 * (src/renderer/titlebar.ts). Invoke channels map 1:1 to the handlers
 * registered in src/main/window-handlers.ts; the "window:maximizedChanged"
 * push is fanned out to renderer-side subscribers, mirroring menu-api.ts.
 */

const listeners = new Set<(maximized: boolean) => void>();

function onMaximizedChanged(_event: IpcRendererEvent, payload: unknown): void {
  // Validate the payload defensively: anything malformed from main is dropped
  // rather than handed to renderer code.
  if (typeof payload !== "boolean") {
    return;
  }
  // Copy so a listener may unsubscribe itself or others during iteration.
  for (const cb of [...listeners]) {
    try {
      cb(payload);
    } catch {
      // One throwing listener must not break the others.
    }
  }
}

// Registered once for the preload lifetime; pushes with no subscribers are
// simply fanned out to an empty set.
ipcRenderer.on("window:maximizedChanged", onMaximizedChanged);

export const windowApi: WindowApi = {
  openNewWindow: () => ipcRenderer.invoke("window:new") as Promise<void>,
  minimize: () => ipcRenderer.invoke("window:minimize") as Promise<void>,
  maximizeOrRestore: () =>
    ipcRenderer.invoke("window:maximizeOrRestore") as Promise<void>,
  close: () => ipcRenderer.invoke("window:close") as Promise<void>,
  isMaximized: () =>
    ipcRenderer.invoke("window:isMaximized") as Promise<boolean>,
  onMaximizedChanged(cb) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};
