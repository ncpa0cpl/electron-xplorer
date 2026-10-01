import { ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { MenuApi, MenuCommand } from "../shared/menu-types";

/**
 * Native application menu bridge: subscribes to the "menu:command" channel
 * that main pushes on (see src/main/menu-handlers.ts) and fans commands out
 * to renderer-side subscribers. Mirrors the style of watch-api.ts.
 */

const listeners = new Set<(command: MenuCommand) => void>();

function onMenuCommand(_event: IpcRendererEvent, payload: unknown): void {
  // Validate the payload defensively: anything malformed from main is dropped
  // rather than handed to renderer code.
  if (typeof payload !== "string" || payload.length === 0) {
    return;
  }

  const command = payload as MenuCommand;
  // Copy so a listener may unsubscribe itself or others during iteration.
  for (const cb of [...listeners]) {
    try {
      cb(command);
    } catch {
      // One throwing listener must not break the others.
    }
  }
}

// Registered once for the preload lifetime; commands with no subscribers are
// simply fanned out to an empty set.
ipcRenderer.on("menu:command", onMenuCommand);

export const menuApi: MenuApi = {
  onMenuCommand(cb) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};
