import { ipcRenderer, webUtils } from "electron";
import type { DndApi } from "../shared/fs-types";

/**
 * Preload-side OS drag-and-drop helpers.
 *
 * `webUtils.getPathForFile` must be called in the preload: `File` objects from
 * an OS drag carry their real absolute path only in privileged contexts. The
 * function is exposed through the contextBridge (which supports passing `File`
 * objects across - this is the documented Electron pattern).
 *
 * `dragOut` forwards the paths of entries being dragged out of the explorer to
 * the main process, which starts the actual native OS drag session
 * (`webContents.startDrag`). It is called at the moment an emulated drag
 * leaves the window, while the pointer grab is still live.
 */
export const dndApi: DndApi = {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  dragOut: (paths) => ipcRenderer.send("system:drag-out", paths),
  takeOwnDrag: (paths) =>
    ipcRenderer.invoke("system:takeOwnDrag", paths) as Promise<boolean>,
  startCursorWatcher: () => ipcRenderer.send("system:start-cursor-watcher"),
  stopCursorWatcher: () => ipcRenderer.send("system:stop-cursor-watcher"),
  onCursorEnter: (cb: () => void) => {
    ipcRenderer.addListener("cursor:enter", cb);
    return () => ipcRenderer.removeListener("cursor:enter", cb);
  },
  onCursorLeave: (cb: () => void) => {
    ipcRenderer.addListener("cursor:leave", cb);
    return () => ipcRenderer.removeListener("cursor:leave", cb);
  },
};
