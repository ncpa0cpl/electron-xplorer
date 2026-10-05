import { app, BrowserWindow, ipcMain } from "electron";
import type { WebContents } from "electron";
import fs from "node:fs";
import { getMainPlatform } from "./platform";

/**
 * Folder-open requests ("launch:*" channels): folders passed on the command
 * line, forwarded by a second launch (`second-instance`), or delivered by
 * macOS Launch Services (`open-file`). Requests are queued until a renderer
 * claims them via "launch:takeFolders", then pushed to that renderer.
 */

const queuedFolders: string[] = [];
let receiver: WebContents | undefined;

/**
 * Also queues the folders in this process's own argv. Call once, before
 * `ready`: macOS emits `open-file` for the launching folder before it.
 *
 * @param createWindow - Called when a folder-less re-launch arrives (an
 *   external OS "New Window" request) or when a request arrives while the
 *   app has no window (macOS keeps running after its last window closes).
 */
export function registerLaunchHandlers(createWindow: () => void): void {
  queuedFolders.push(...argvFolders(process.argv));

  ipcMain.handle("launch:takeFolders", (event): string[] => {
    receiver = event.sender;
    return queuedFolders.splice(0);
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    openFolders(existingFolders([filePath]), createWindow);
  });

  app.on("second-instance", (_event, argv) => {
    const folders = argvFolders(argv);
    if (folders.length === 0) {
      // A folder-less re-launch - which is how external OS "New Window" requests
      // arrive (e.g. GNOME Dash-to-Dock: RMB on the dock icon → New Window
      // re-executes the desktop entry; the single-instance lock turns it
      // into this event). Open ANOTHER window instead of focusing the
      // existing one, as file managers conventionally do.
      createWindow();
      return;
    }
    // A launch carrying folder paths ("Open folder with…") - open them as
    // tabs in the existing window.
    openFolders(folders, createWindow);
  });
}

function openFolders(folders: string[], createWindow: () => void): void {
  if (receiver && !receiver.isDestroyed()) {
    if (folders.length > 0) {
      receiver.send("launch:openFolders", folders);
    }
    const win = BrowserWindow.fromWebContents(receiver);
    if (win?.isMinimized()) {
      win.restore();
    }
    // Launch Services activates the app for `open-file`, but nothing
    // activates it for `second-instance`.
    app.focus({ steal: true });
    win?.focus();
    return;
  }

  queuedFolders.push(...folders);
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
}

// argv starts with the executable, plus the app path when run via `electron .`
function argvFolders(argv: readonly string[]): string[] {
  return existingFolders(argv.slice(process.defaultApp ? 2 : 1));
}

function existingFolders(paths: readonly string[]): string[] {
  return paths.filter(
    (p) =>
      getMainPlatform().isValidAbsolutePath(p)
      && fs.statSync(p, { throwIfNoEntry: false })?.isDirectory(),
  );
}
