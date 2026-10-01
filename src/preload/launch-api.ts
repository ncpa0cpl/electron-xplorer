import { ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { LaunchApi } from "../shared/launch-types";

/**
 * Folder-open request bridge: "launch:takeFolders" pulls the queued requests,
 * "launch:openFolders" pushes later ones (see src/main/launch-handlers.ts).
 * Mirrors the style of menu-api.ts.
 */

const listeners = new Set<(folders: readonly string[]) => void>();

function onOpenFolders(_event: IpcRendererEvent, payload: unknown): void {
  if (
    !Array.isArray(payload)
    || !payload.every((p) => typeof p === "string" && p.length > 0)
  ) {
    return;
  }

  const folders = payload as string[];
  for (const cb of [...listeners]) {
    try {
      cb(folders);
    } catch {
      // One throwing listener must not break the others.
    }
  }
}

ipcRenderer.on("launch:openFolders", onOpenFolders);

export const launchApi: LaunchApi = {
  takeLaunchFolders: () =>
    ipcRenderer.invoke("launch:takeFolders") as Promise<string[]>,
  onOpenFolders(cb) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};
