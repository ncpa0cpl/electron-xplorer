import { app, BrowserWindow } from "electron";
import started from "electron-squirrel-startup";
import path from "node:path";
import {
  registerDragHandlers,
  registerWindowEnterLeaveWatcher,
} from "./drag-handlers";
import { registerFsHandlers } from "./fs-handlers";
import { registerMediaHandlers } from "./media-handlers";
import { registerXmediaScheme } from "./media-protocol";
import { registerMenuHandlers } from "./menu-handlers";
import { getMainPlatform } from "./platform";
import { registerSystemHandlers } from "./system-handlers";
import { registerWatcherHandlers } from "./watcher-handlers";
// Window state persistence - bounds ONLY (size/position/maximized; the last
// visited directory is deliberately never persisted: the app always opens in
// the home directory).
import { loadWindowState, trackWindowState } from "./window-state";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Privileged scheme registration must happen before the app `ready` event.
registerXmediaScheme();

// Register every IPC handler before any window exists.
registerFsHandlers();
registerSystemHandlers();
registerWatcherHandlers();
registerMediaHandlers();
registerMenuHandlers();
registerDragHandlers();

const createWindow = () => {
  // Restore previously persisted window bounds (size clamped to the minimum,
  // off-screen positions dropped so the window centers). `undefined` x/y let
  // Electron use its default centering.
  const state = loadWindowState();
  const mainWindow = new BrowserWindow({
    title: "Electron Xplorer",
    width: state?.width ?? 1280,
    height: state?.height ?? 800,
    x: state?.x,
    y: state?.y,
    minWidth: 720,
    minHeight: 480,
    // Created hidden; shown on `ready-to-show` below to avoid a white flash
    // before the renderer paints.
    show: false,
    // Dark background to avoid a white flash before the renderer paints.
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setAutoHideMenuBar(true);

  registerWindowEnterLeaveWatcher(mainWindow);

  // Persist window bounds ONLY: debounced on resize/move, synchronous on
  // close. Must be attached right after creation so no change is missed.
  trackWindowState(mainWindow);

  // Restore the maximized flag as part of the persisted state.
  mainWindow.once("ready-to-show", () => {
    if (state?.maximized) {
      mainWindow.maximize();
      mainWindow.show();
    } else {
      mainWindow.show();
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Only open DevTools when explicitly requested (e.g. ELECTRON_XPLORER_DEVTOOLS=1
  // for interactive debugging). This keeps automated screenshot runs clean.
  if (process.env.ELECTRON_XPLORER_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools();
  }
};

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
