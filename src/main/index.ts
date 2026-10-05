import { app, BrowserWindow } from "electron";
import started from "electron-squirrel-startup";
import { registerDragHandlers } from "./drag-handlers";
import { registerFsHandlers } from "./fs-handlers";
import { registerLaunchHandlers } from "./launch-handlers";
import { registerMediaHandlers } from "./media-handlers";
import { registerXmediaScheme } from "./media-protocol";
import { registerMenuHandlers } from "./menu-handlers";
import { getMainPlatform } from "./platform";
import { registerSystemHandlers } from "./system-handlers";
import { registerTrashHandlers } from "./trash-handlers";
import { registerWatcherHandlers } from "./watcher-handlers";
import { registerWindowHandlers } from "./window-handlers";
// Window creation lives in ./window-creator (shared by every "new window"
// entry point). Window state persistence - bounds ONLY (size/position/
// maximized; the last visited directory is deliberately never persisted: the
// app opens in the home directory, or in the folder it was launched with) -
// stays in ./window-state.
import { createWindow, registerNewWindowHandler } from "./window-creator";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// A second launch forwards its argv to this instance (`second-instance` in
// launch-handlers.ts). `exit` rather than `quit`: before `ready` it ends the
// process immediately, without creating a window.
if (!app.requestSingleInstanceLock()) {
  app.exit();
}

// Privileged scheme registration must happen before the app `ready` event.
registerXmediaScheme();

// Register every IPC handler before any window exists.
registerFsHandlers();
registerSystemHandlers();
registerTrashHandlers();
registerWatcherHandlers();
registerMediaHandlers();
registerMenuHandlers();
registerDragHandlers();
registerWindowHandlers();
registerNewWindowHandler();

registerLaunchHandlers(createWindow);

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", createWindow);

// Quit when all windows are closed, except on macOS (platform behavior via
// the main platform bridge): there it's common for applications and their
// menu bar to stay active until the user quits explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (getMainPlatform().quitAfterAllWindowsClosed()) {
    app.quit();
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
