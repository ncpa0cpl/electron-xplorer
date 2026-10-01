import type { FStat } from "fs-explorer";
import { rendererPlatform } from "./platform";

/**
 * Hybrid drag-and-drop model.
 *
 * - **Inside the window**: drags are handled entirely by fs-explorer's
 *   emulated (mouse-event based) drag — directory highlight, internal MOVE
 *   semantics and cross-tab drops all work as they do without any native
 *   drag involvement.
 * - **Leaving the window**: while the pointer is still held, the moment it
 *   exits the window the library calls the `nativeDragOut` option below. We
 *   then hand the drag to the OS via fire-and-forget IPC ("system:drag-out"
 *   channel → `webContents.startDrag` in the main process). The button is
 *   still held at that point, so the pointer grab is live and Electron can
 *   take over the drag session mid-gesture.
 * - **Dropping back into the app**: once a drag has been handed to the OS it
 *   is indistinguishable from a drag coming from any external application,
 *   so dropping it back into this app is a COPY (handled by the regular OS
 *   drag-in path in `actions.ts`) — same as real file managers.
 *
 * The handler below is invoked by the library only when an already-active
 * emulated drag leaves the window; no OS drag is ever started for drags that
 * stay inside the window.
 */

/** Must match the limit enforced by the `system:drag-out` main handler. */
const MAX_DRAG_PATHS = 100;

export function nativeDragOutHandler(files: readonly FStat[]): boolean {
  console.log("nativeDragOutHandler");
  const paths = files
    .map((f) => f.path)
    .filter(
      (p): p is string =>
        typeof p === "string" && rendererPlatform().paths.isAbsolute(p),
    );
  if (paths.length < 1 || paths.length > MAX_DRAG_PATHS) {
    return false;
  }

  const { dragOut } = window.xplorer;
  if (typeof dragOut !== "function") {
    // Bridge not available - keep the default behavior (drag is cancelled).
    return false;
  }

  // Fire-and-forget IPC: the main process calls `webContents.startDrag`
  // with these paths, taking over the in-progress drag session.
  dragOut(paths);

  return true;
}
