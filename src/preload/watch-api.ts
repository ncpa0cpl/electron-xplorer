import { ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { FsChangeEvent, WatchApi } from "../shared/watch-types";

/**
 * File-change watching bridge: subscribes to the "fs:change" channel that
 * main pushes on (see src/main/watcher-handlers.ts) and fans events out to
 * renderer-side subscribers. Also forwards the renderer-declared set of
 * directories to watch ("watch:setDirs" channel).
 */

const listeners = new Set<(event: FsChangeEvent) => void>();

function onFsChangeEvent(_event: IpcRendererEvent, payload: unknown): void {
  // Validate the payload defensively: anything malformed from main is dropped
  // rather than handed to library code.
  if (
    typeof payload !== "object" || payload === null
    || typeof (payload as FsChangeEvent).dirPath !== "string"
    || (payload as FsChangeEvent).dirPath.length === 0
  ) {
    return;
  }

  const event = payload as FsChangeEvent;
  // Copy so a listener may unsubscribe itself or others during iteration.
  for (const cb of [...listeners]) {
    try {
      cb(event);
    } catch {
      // One throwing listener must not break the others.
    }
  }
}

// Registered once for the preload lifetime; events with no subscribers are
// simply fanned out to an empty set.
ipcRenderer.on("fs:change", onFsChangeEvent);

export const watchApi: WatchApi = {
  onFsChange(cb) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  setWatchedDirs(dirs) {
    // Fire-and-forget: main validates and synchronizes its watcher registry
    // to this set (see src/main/watcher-handlers.ts).
    ipcRenderer.send("watch:setDirs", [...dirs]);
  },
};
