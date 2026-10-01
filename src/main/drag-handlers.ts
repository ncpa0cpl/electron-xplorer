import { BrowserWindow, ipcMain, nativeImage, screen } from "electron";
import { getMainPlatform } from "./platform";

/**
 * Native OS drag-out of file entries ("system:drag-out" channel).
 *
 * The renderer sends the absolute paths of the dragged entries at the moment
 * an emulated drag leaves the window (see `src/renderer/drag-out.ts`); the
 * actual OS drag session is started here in the main process via
 * `webContents.startDrag`, which takes over the in-progress drag mid-gesture
 * (the pointer grab is still live at that point).
 */

/** Maximum number of paths accepted in a single drag-out request. */
const MAX_DRAG_PATHS = 100;

/**
 * 32x32 generic "document" icon (neutral gray/blue) shown under the cursor
 * during the drag. The icon is required by `startDrag` on some platforms.
 * Cached at module level: the image is immutable, so it only needs to be
 * created once.
 */
const DRAG_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAS0lEQVR4nGNgGAWjgACIr53znxJMFQfcefaBLDzqgFEHUN0BXYt2EY2HZwiMOmA0DYw6YDQNjDoAX3yPjBAYdcCAOWBAm+WjYNgDABhMDYCyPtzEAAAAAElFTkSuQmCC";

let dragIcon: Electron.NativeImage | null = null;

function getDragIcon(): Electron.NativeImage {
  if (dragIcon === null) {
    dragIcon = nativeImage.createFromDataURL(DRAG_ICON_DATA_URL);
  }
  return dragIcon;
}

/** Registers all drag handlers. Call once during app startup. */
export function registerDragHandlers(): void {
  /**
   * Fire-and-forget (`ipcMain.on`, not `handle`): the renderer must not await
   * a response - the native drag is started here as soon as the message
   * arrives, taking over the in-progress drag session.
   */
  ipcMain.on("system:drag-out", (event, paths: unknown) => {
    if (!Array.isArray(paths)) return;
    if (paths.length < 1 || paths.length > MAX_DRAG_PATHS) return;

    const validPaths = paths.filter(
      (p): p is string =>
        typeof p === "string" && getMainPlatform().isValidAbsolutePath(p),
    );
    if (validPaths.length === 0) return;

    try {
      event.sender.startDrag({
        file: validPaths[0],
        files: validPaths,
        icon: getDragIcon(),
      });
    } catch (err) {
      console.error("system:drag-out: startDrag failed:", err);
    }
  });
}

function watchCursor(
  win: BrowserWindow,
  onEnter: () => void,
  onLeave: () => void,
  intervalMs = 32,
) {
  let inside: boolean = true;

  const timer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(timer);

    const p = screen.getCursorScreenPoint();
    const b = win.getBounds(); // or getContentBounds() to exclude frame/title bar

    const nowInside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y
      && p.y < b.y + b.height;

    if (nowInside !== inside) {
      inside = nowInside;
      nowInside ? onEnter() : onLeave();
    }
  }, intervalMs);

  win.on("closed", () => clearInterval(timer));
  return () => clearInterval(timer);
}

export function registerWindowEnterLeaveWatcher(win: BrowserWindow) {
  let removeWatcher: (() => void) | null = null;

  ipcMain.on("system:start-cursor-watcher", () => {
    if (removeWatcher) return;

    console.log("created cursor watcher");
    removeWatcher = watchCursor(
      win,
      () => {
        console.log("detected cursor enter");
        ipcMain.emit("cursor:enter");
      },
      () => {
        console.log("detected cursor leave");
        ipcMain.emit("cursor:leave");
      },
    );
  });

  ipcMain.on("system:stop-cursor-watcher", () => {
    if (removeWatcher) {
      console.log("removed cursor watcher");
      removeWatcher();
      removeWatcher = null;
    }
  });
}
