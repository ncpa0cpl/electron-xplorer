import { app, screen } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * Window state persistence - BOUNDS ONLY (product decision).
 *
 * Persists just the window size/position/maximized flag to
 * `userData/window-state.json` (plain fs, no dependencies). Deliberately
 * NEVER persists the last visited directory: the app always opens in the
 * home directory (the Explorer is constructed with `initDir: homeDir`).
 *
 * Restore policy:
 * - size clamped to the app's minimum (720x480);
 * - position kept only when the restored window rect intersects at least one
 *   connected display, otherwise dropped so Electron's default centering
 *   applies (x/y are simply omitted from the BrowserWindow options);
 * - the maximized flag is restored after `ready-to-show` (see main/index.ts).
 */

export interface WindowState {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
}

/** Must mirror the BrowserWindow minWidth/minHeight in main/index.ts. */
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;

/** Debounce for the resize/move tracking saves. */
const SAVE_DEBOUNCE_MS = 500;

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

/**
 * Reads and sanitizes the persisted state. Returns undefined when the file is
 * missing, corrupt or has no usable size. Must be called after `app.ready`
 * (uses the `screen` module for the off-screen check).
 */
export function loadWindowState(): WindowState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFilePath(), "utf8");
  } catch {
    // Missing state file (first run) - use defaults.
    return undefined;
  }

  let data: Partial<WindowState> | undefined;
  try {
    data = JSON.parse(raw) as Partial<WindowState>;
  } catch (err) {
    // Corrupt state file - ignore it rather than failing to launch.
    console.warn(
      "window-state.json is corrupt, using default window bounds:",
      err,
    );
    return undefined;
  }

  if (typeof data?.width !== "number" || typeof data?.height !== "number") {
    return undefined;
  }

  const state: WindowState = {
    width: Math.max(MIN_WIDTH, Math.round(data.width)),
    height: Math.max(MIN_HEIGHT, Math.round(data.height)),
    maximized: data.maximized === true,
  };

  // Position: keep only plausible, on-screen values (a stale position from a
  // since-disconnected monitor would otherwise land the window off-screen).
  if (
    typeof data.x === "number" && Number.isFinite(data.x)
    && typeof data.y === "number" && Number.isFinite(data.y)
  ) {
    const x = Math.round(data.x);
    const y = Math.round(data.y);
    const rect = { x, y, width: state.width, height: state.height };
    const onScreen = screen.getAllDisplays().some((display) => {
      const b = display.bounds;
      return x < b.x + b.width && x + rect.width > b.x
        && y < b.y + b.height && y + rect.height > b.y;
    });
    if (onScreen) {
      return { ...state, x, y };
    }
    console.warn("Saved window position is off-screen; centering instead.");
  }

  return state;
}

/** Serializes and writes the current state (fire-and-forget). */
function saveWindowState(win: Electron.BrowserWindow): void {
  // `getNormalBounds` returns the pre-maximize bounds even while maximized,
  // so restoring size/position stays sane together with the `maximized` flag.
  const normal = win.getNormalBounds();
  const state: WindowState = {
    width: normal.width,
    height: normal.height,
    x: normal.x,
    y: normal.y,
    maximized: win.isMaximized(),
  };
  fs.promises
    .writeFile(stateFilePath(), JSON.stringify(state, null, 2), "utf8")
    .catch((err) => {
      console.error("Failed to save window state:", err);
    });
}

/**
 * Attaches the persistence listeners to a window: debounced saves on
 * resize/move plus a synchronous save on close (the process may exit right
 * after, so the final bounds must be flushed synchronously).
 */
export function trackWindowState(win: Electron.BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const scheduleSave = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!win.isDestroyed()) {
        saveWindowState(win);
      }
    }, SAVE_DEBOUNCE_MS);
  };

  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);

  win.on("close", () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!win.isDestroyed()) {
      try {
        // Same serialization as saveWindowState, but synchronous.
        const normal = win.getNormalBounds();
        const state: WindowState = {
          width: normal.width,
          height: normal.height,
          x: normal.x,
          y: normal.y,
          maximized: win.isMaximized(),
        };
        fs.writeFileSync(
          stateFilePath(),
          JSON.stringify(state, null, 2),
          "utf8",
        );
      } catch (err) {
        console.error("Failed to save window state on close:", err);
      }
    }
  });
}
