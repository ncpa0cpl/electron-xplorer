import { BrowserWindow, ipcMain } from "electron";

/**
 * Window-control IPC handlers ("window:*" channels): minimize / maximize /
 * restore / close, plus maximized-state push for the custom integrated
 * titlebar (src/renderer/titlebar.ts).
 *
 * All invoke handlers resolve the TARGET WINDOW from the event sender
 * (`BrowserWindow.fromWebContents`) rather than a global singleton, so the
 * channels keep working per-window and are inert (graceful no-ops) if the
 * sender's window is already gone.
 *
 * Registered with raw `ipcMain.handle` (like "system:setWindowTitle"): the
 * typed `handle()` helper in src/main/ipc.ts validates absolute paths, which
 * does not apply to these argument-less channels.
 */

/** Registers all window-control handlers. Call once during app startup. */
export function registerWindowHandlers(): void {
  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("window:maximizeOrRestore", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  // Initial-state query (avoids a push/consume race on startup: the renderer
  // asks once right after mounting the titlebar).
  ipcMain.handle("window:isMaximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
}

/**
 * Attaches the maximized-state push to a window: every `maximize` /
 * `unmaximize` event is forwarded to the window's own webContents on the
 * "window:maximizedChanged" channel as a plain boolean.
 *
 * Must be called right after each window's creation (see createWindow in
 * src/main/index.ts) so no state change can be missed.
 */
export function trackWindowMaximizedState(win: Electron.BrowserWindow): void {
  const send = (maximized: boolean): void => {
    if (!win.isDestroyed()) {
      win.webContents.send("window:maximizedChanged", maximized);
    }
  };
  win.on("maximize", () => send(true));
  win.on("unmaximize", () => send(false));
}
