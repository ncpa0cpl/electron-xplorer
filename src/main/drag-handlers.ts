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
 * Paths an in-progress app-initiated OS drag is carrying (path → drag-out
 * time). `webContents.startDrag` cannot tag a drag with custom metadata, so
 * a drop back into this app cannot identify its source directly.
 *
 * `startDrag` emits no drag-end event, so entries are consumed by a claim
 * or expire - the TTL bounds the window in which an EXTERNAL drag of the
 * same paths (e.g. right after a cancelled app drag) is mistaken for an app
 * drag and moved instead of copied.
 */
const dragOwnership = new Map<string, number>();
const DRAG_OWNERSHIP_TTL_MS = 30_000;

function pruneDragOwnership(now: number): void {
  for (const [p, t] of dragOwnership) {
    if (now - t > DRAG_OWNERSHIP_TTL_MS) {
      dragOwnership.delete(p);
    }
  }
}

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

    // Registered before startDrag, which on darwin blocks until the drag
    // ends.
    pruneDragOwnership(Date.now());
    for (const p of validPaths) {
      dragOwnership.set(p, Date.now());
    }

    try {
      event.sender.startDrag({
        file: validPaths[0],
        files: validPaths,
        icon: getDragIcon(),
      });
    } catch (err) {
      console.error("system:drag-out: startDrag failed:", err);
      for (const p of validPaths) {
        dragOwnership.delete(p);
      }
    }
  });

  /**
   * Ownership claim for a drop arriving in one of this app's windows:
   * answers `true` only when EVERY dropped path was just dragged out of
   * this app, consuming those records (the move must not be claimed twice).
   * Paths must arrive app-canonicalized - the renderer normalizes both the
   * drag-out side and the dropped side via shared `Platform.paths.normalize`
   * (dropped paths come back from `getPathForFile` in the OS's native form).
   * Raw `ipcMain.handle` (array arg, like trash-handlers.ts).
   */ ipcMain.handle(
    "system:takeOwnDrag",
    (_event, paths: unknown): boolean => {
      if (!Array.isArray(paths) || paths.length === 0) {
        return false;
      }
      if (!paths.every((p) => typeof p === "string")) {
        return false;
      }
      const now = Date.now();
      const unowned = paths.some((p) => {
        const t = dragOwnership.get(p as string);
        return t === undefined || now - t > DRAG_OWNERSHIP_TTL_MS;
      });
      if (unowned) {
        return false;
      }
      for (const p of paths) {
        dragOwnership.delete(p as string);
      }
      return true;
    },
  );
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
