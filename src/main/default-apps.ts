import { app } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Apps the user picked via "Open With…", keyed by file extension and
 * persisted to `userData/default-apps.json`. Only macOS uses this: its
 * application chooser cannot change the system default app (see
 * src/main/platform/darwin.ts).
 *
 * Extensionless files are never recorded: a shell script, a binary and a
 * LICENSE share no extension, yet would all share one entry.
 */

const DEFAULT_APPS_FILE = "default-apps.json";

/** Lowercased extension including the dot (".txt") → absolute app path. */
type DefaultAppMap = Record<string, string>;

let loaded: Promise<DefaultAppMap> | undefined;

function defaultAppsPath(): string {
  return path.join(app.getPath("userData"), DEFAULT_APPS_FILE);
}

function loadMap(): Promise<DefaultAppMap> {
  loaded ??= readMap();
  return loaded;
}

/** Reads the map; any error (missing/corrupt file) yields `{}`. */
async function readMap(): Promise<DefaultAppMap> {
  try {
    const raw = await fs.readFile(defaultAppsPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const map: DefaultAppMap = {};
    for (const [ext, appPath] of Object.entries(parsed)) {
      if (typeof appPath === "string" && appPath.length > 0) {
        map[ext] = appPath;
      }
    }
    return map;
  } catch {
    return {};
  }
}

async function writeMap(map: DefaultAppMap): Promise<void> {
  try {
    await fs.mkdir(path.dirname(defaultAppsPath()), { recursive: true });
    await fs.writeFile(defaultAppsPath(), JSON.stringify(map, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save default apps:", err);
  }
}

function extensionKey(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return ext === "" ? undefined : ext;
}

/**
 * @returns The app last recorded for the file's extension, or `undefined`
 *   when there is none or the file has no extension.
 */
export async function getDefaultApp(
  filePath: string,
): Promise<string | undefined> {
  const key = extensionKey(filePath);
  return key === undefined ? undefined : (await loadMap())[key];
}

/**
 * Records `appPath` for every file sharing `filePath`'s extension. No-op for
 * extensionless files. Save failures are logged, not thrown.
 */
export async function setDefaultApp(
  filePath: string,
  appPath: string,
): Promise<void> {
  const key = extensionKey(filePath);
  if (key === undefined) {
    return;
  }
  const map = await loadMap();
  map[key] = appPath;
  await writeMap(map);
}
