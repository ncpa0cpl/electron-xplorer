import { BrowserWindow, ipcMain, screen } from "electron";
import path from "node:path";
import { registerWindowEnterLeaveWatcher } from "./drag-handlers";
import { getMainPlatform } from "./platform";
import {
  attachInputContextMenu,
  trackWindowMaximizedState,
} from "./window-handlers";
import { loadWindowState, trackWindowState } from "./window-state";

/**
 * Window creation.
 *
 * Every "new window" entry point funnels through `createWindow()`:
 * application menu File > New Window, the renderer toolbar "New Window"
 * action ("window:new" channel), and external OS new-window requests (e.g.
 * a GNOME Dash-to-Dock re-launch, which arrives as `second-instance` with
 * no folder arguments - see launch-handlers.ts).
 *
 * Only the FIRST window restores the persisted bounds; every additional
 * window opens at the default size, cascaded below/right of the previous
 * one.
 */

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

/** Offset between successive fresh (non-restored) windows, in px. */
const CASCADE_STEP = 28;
const CASCADE_MAX_STEPS = 10;

export function createWindow(): BrowserWindow {
  // Persisted bounds only for the first window; undefined x/y fall back to
  // Electron's default centering (restore policy in window-state.ts).
  const isFirst = BrowserWindow.getAllWindows().length === 0;
  const state = isFirst ? loadWindowState() : undefined;

  const mainWindow = new BrowserWindow({
    title: "Electron Xplorer",
    width: state?.width ?? DEFAULT_WIDTH,
    height: state?.height ?? DEFAULT_HEIGHT,
    x: state?.x,
    y: state?.y,
    ...cascadePosition(BrowserWindow.getAllWindows().length),
    minWidth: 920,
    minHeight: 480,
    // Created hidden; shown on `ready-to-show` below to avoid a white flash
    // before the renderer paints.
    show: false,
    // Dark background to avoid a white flash before the renderer paints.
    backgroundColor: "#1e1e1e",
    // Custom integrated titlebar (src/renderer/titlebar.ts) replacing the
    // native one: on macOS keep the native traffic lights at their default
    // top-left position (only the native title bar is hidden); on every other
    // platform drop the native frame entirely - the renderer titlebar draws
    // its own window-control buttons on the right. Per-platform options come
    // from the main platform bridge (one-switch rule).
    ...getMainPlatform().titlebarWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Keep the auto-hidden menu bar: with `frame: false` a non-auto-hidden
  // application menu is always rendered INSIDE the window (below the custom
  // titlebar area), stealing vertical space; hidden, it still reveals on Alt
  // and all of its accelerators keep working.
  mainWindow.setAutoHideMenuBar(true);

  registerWindowEnterLeaveWatcher(mainWindow);

  // Native edit context menu on editable fields (Undo/Cut/Copy/Paste/...).
  // Attached right after creation, like the other per-window hooks below.
  attachInputContextMenu(mainWindow);

  // Push maximize/unmaximize state to the renderer titlebar
  // ("window:maximizedChanged" channel). Attached right after creation so no
  // state change is missed.
  trackWindowMaximizedState(mainWindow);

  // Persist window bounds ONLY: debounced on resize/move, synchronous on
  // close. Every window tracks into the same state file - last closed wins.
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

  return mainWindow;
}

/**
 * Positions a fresh (non-restored) window inside the primary display's work
 * area, cascaded below-right so successive windows stay visible.
 *
 * @param index - Number of windows that already exist. 0 omits the
 *   coordinates, leaving placement to Electron's default centering.
 */
function cascadePosition(index: number): { x?: number; y?: number } {
  if (index <= 0) {
    return {};
  }
  const { workArea } = screen.getPrimaryDisplay();
  const baseX = workArea.x
    + Math.max(0, Math.floor((workArea.width - DEFAULT_WIDTH) / 2));
  const baseY = workArea.y
    + Math.max(0, Math.floor((workArea.height - DEFAULT_HEIGHT) / 2));
  const step = index % CASCADE_MAX_STEPS;
  return { x: baseX + step * CASCADE_STEP, y: baseY + step * CASCADE_STEP };
}

/**
 * Registers the renderer-invoked new-window channel ("window:new").
 *
 * Lives here rather than in window-handlers.ts: that module exports the
 * per-window hooks this file attaches, so importing createWindow back would
 * be an import cycle.
 *
 * Raw `ipcMain.handle` (argument-less channel - same reason as the other
 * "window:*" handlers, see window-handlers.ts).
 */
export function registerNewWindowHandler(): void {
  ipcMain.handle("window:new", () => {
    createWindow();
  });
}
