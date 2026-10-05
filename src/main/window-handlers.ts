import { BrowserWindow, ipcMain, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";

/**
 * Window-control IPC handlers ("window:*" channels): minimize / maximize /
 * restore / close, plus maximized-state push for the custom integrated
 * titlebar (src/renderer/titlebar.ts).
 *
 * The one "window:*" channel NOT registered here is "window:new" (opens a
 * new application window): it lives in window-creator.ts, which owns window
 * creation and imports this module - registering it here as well would
 * create an import cycle.
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
 * Attaches a native edit context menu to a window, shown ONLY when the
 * right-click target is an editable field (`params.isEditable`: path bar,
 * rename prompt, search box, ...). Electron never shows a default context
 * menu, so without this RMB on inputs is a no-op and copy/paste is
 * keyboard-only.
 *
 * Roles (`cut`/`copy`/`paste`/...) act on the webContents' *text* selection,
 * which is exactly what we want here and is distinct from the lib's file
 * clipboard (see menu-handlers.ts for why roles must NOT be used in the
 * application menu). Deliberately no accelerators on these items: the
 * renderer already binds Ctrl+C/X/V/A with focus guards, and adding
 * accelerators here would intercept keys before the renderer sees them.
 *
 * Must be called right after each window's creation (see createWindow in
 * src/main/window-creator.ts).
 */
export function attachInputContextMenu(win: Electron.BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) {
      return;
    }
    // `enabled` states derive from the event's edit flags so items the
    // action cannot apply to (e.g. Copy with no selection) are greyed out.
    const flags = params.editFlags;
    const template: MenuItemConstructorOptions[] = [
      { role: "undo", enabled: flags.canUndo },
      { role: "redo", enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll },
    ];
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

/**
 * Attaches the maximized-state push to a window: every `maximize` /
 * `unmaximize` event is forwarded to the window's own webContents on the
 * "window:maximizedChanged" channel as a plain boolean.
 *
 * Must be called right after each window's creation (see createWindow in
 * src/main/window-creator.ts) so no state change can be missed.
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
