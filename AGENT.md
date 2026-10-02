# AGENT.md — electron-xplorer

Electron 44 file explorer app ("Electron Xplorer"): tabbed browsing, preview pane, thumbnails, context menus, OS drag-and-drop, trash, terminals. Built with electron-forge + Vite; renderer UI written with `@ncpa0cpl/vanilla-jsx` hyperscript and styled with adwavecss/adwaveui + `src/index.css`.

The explorer UI itself comes from the sibling library `@ncpa0cpl/fs-explorer`.

## Commands

```sh
yarn start        # run the app (electron-forge start; rm -rf node_modules/.vite first)
yarn make:deb | make:rpm | make:appimage | make:macos   # packaging
npx tsc --noEmit  # typecheck (pass bar: no NEW errors beyond the 7 pre-existing ones)
npx dprint check  # formatting (run `npx dprint fmt <files-you-touched>` only)
npx eslint src --ext .ts,.tsx   # currently CRASHES under TS7 (pre-existing env issue)
yarn test-platform  # scripts/test-platform.mjs — platform-module smoke test
```

## Process architecture

Three Vite bundles (`vite.main.config.mts`, `vite.preload.config.mts`, `vite.renderer.config.mts`; shared resolve helpers in `vite.shared.mts`):

- **Main** — `src/main.ts` → `src/main/index.ts`. Window creation, app lifecycle, all `ipcMain` handlers, menu bar, file watching, thumbnails, platform OS integration. Forge config: `forge.config.ts` (asar, Makers for win/mac/linux, VitePlugin, fuses).
- **Preload** — `src/preload.ts` → `src/preload/index.ts`. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`. Merges per-domain API modules into `window.xplorer`.
- **Renderer** — `src/renderer/index.ts` → `src/renderer/app.ts` `bootstrap()`.

## Directory map

```
src/main/
  index.ts               app entry: createWindow(), handler registration, single-window
  ipc.ts                 typed handle(channel, argSpec, fn) wrapper — validates "path" args
                         (non-empty, no NUL byte, platform-absolute)
  fs-handlers.ts         fs:* channels (readdirStat, stat, copy, move, remove, mkdir,
                         touch, readFile, trash). trash() also records a sidecar entry
  trash-handlers.ts      fs:listTrash / fs:restoreTrash / fs:emptyTrash
                         (emptyTrash also clears the sidecar ledger on success)
  trash-records.ts       userData/trash-records.json sidecar (originalPath ledger)
  default-apps.ts        userData/default-apps.json: per-extension app picked via
                         "Open With…" (darwin only; see darwin.ts openPath)
  system-handlers.ts     system:* channels (openPath, openInTerminal, openWith,
                         getHomeDir, getStaticPlaces, getPlatformInfo, setWindowTitle)
  window-handlers.ts     window:minimize|maximizeOrRestore|close|isMaximized +
                         trackWindowMaximizedState() → pushes window:maximizedChanged
  window-state.ts        persists window bounds/maximized to userData/window-state.json
  menu-handlers.ts       native app menu; pushes menu:command (MenuCommand enum,
                         src/shared/menu-types.ts) to the renderer
  watcher-handlers.ts    one non-recursive fs.watch per visited dir → pushes fs:change
  media-handlers.ts / media-protocol.ts   thumbnails (nativeImage, disk cache,
                         xmedia:// URL protocol), getMediaUrl for preview playback
  drag-handlers.ts       OS drag-out + cursor watcher (system:drag-out, start/stop-cursor-watcher)
  platform/              THE platform abstraction (see below)
src/preload/             one module per API domain, merged in index.ts:
  fs-api.ts, system-api.ts, trash-api.ts, watch-api.ts, media-api.ts,
  menu-api.ts, dnd-api.ts, window-api.ts
src/shared/              types shared across processes:
  fs-types.ts            DirEntry, PlaceInfo, FsApi/SystemApi/TrashApi/WatchApi/MediaApi/
                         MenuApi/DndApi/WindowApi, XplorerApi intersection
  menu-types.ts          MenuCommand enum
  platform/              pure path/hidden-file logic duplicated in the renderer
                         (posix.ts shared by linux+darwin, win32.ts, unknown.ts,
                         createPlatform(platformId) factory in types.ts)
src/renderer/
  app.ts                 bootstrap(): fetches homeDir/staticPlaces/platformId, builds
                         Explorer, mounts titlebar + explorer (div.app-shell flex column),
                         maps menu commands onto the Explorer API (setupMenuCommands)
  fs-adapter.ts          THE fs-explorer Filesystem implementation over window.xplorer
                         IPC; builds FStats via the shared Platform; intercepts trash:///
  actions.ts             openAction (double-click), fileActions/explorerActions context
                         menu actions, OS drag-in, window-title sync, error overlay helper
  titlebar.ts            custom top bar (see Features)
  drag-out.ts            hybrid drag-out (lib emulated drag → OS handoff)
  media-thumbs.ts        canvas-generated thumbnails (videos/GIF/SVG…) pushed to main cache
  platform.ts            holds the shared Platform instance (initRendererPlatform)
```

## Platform abstraction (the one-switch rule)

- Main: the ONLY `process.platform` switch is `getMainPlatform()` in `src/main/platform/index.ts` → one of `linux.ts` / `darwin.ts` / `win32.ts` / `unknown.ts`, all implementing `MainPlatform` (`platform/types.ts`). Current interface: `getStaticPlaces`, `openPath`, `openInTerminal`, `openWithDialog`, `listTrash`, `restoreTrash`, `emptyTrash`, `isValidAbsolutePath`, `protocolPathToAbsolute`, `accelerator`, `usesAppMenu`, `quitAfterAllWindowsClosed`, `titlebarWindowOptions`.
- Renderer: platform crosses IPC exactly once (`system:getPlatformInfo`); all path/hidden-name logic goes through the pure `Platform` from `src/shared/platform/`. No `process.platform` in renderer code.
- Adding platform behavior = extend `MainPlatform` + implement in all four files (`unknown.ts` rejects or no-ops). See README "Adding a platform".

## IPC patterns

- Typed channels: `handle(channel, ["path", ...], fn)` from `src/main/ipc.ts` — use for anything whose args are paths (it validates absoluteness via `getMainPlatform().isValidAbsolutePath`).
- Non-path/complex args (arrays, booleans): use raw `ipcMain.handle` with inline validation (see `trash-handlers.ts` `fs:restoreTrash`, `system-handlers.ts` `system:setWindowTitle`).
- Push channels main→renderer: `menu:command`, `fs:change` (with `dirPath` — must equal the exact string the dir was browsed with), `window:maximizedChanged`.
- Every new capability is a vertical slice: shared type in `src/shared/fs-types.ts` → preload module merged into `window.xplorer` in `src/preload/index.ts` → main handler registered in `src/main/index.ts` → renderer consumer (adapter or action).
- Registration order: all `register*Handlers()` run in `src/main/index.ts` before any window exists.

## Renderer ↔ library contract

- `fs-adapter.ts` implements the lib's `Filesystem` interface (`readdirStat` batched over one IPC call; change-watching forwards main's `dirPath` verbatim; thumbnails: main disk-cache → renderer canvas fallback).
- The lib's `Explorer` is configured in `app.ts` with `openAction`, `actions` (context menu), `explorerActions` (toolbar), `staticPlaces` (OS places + Trash), `fileDropHandler`, `nativeDragOut`.
- The lib's shipped d.ts degrades signal-typed fields to `any` (its `@ncpa0cpl/vanilla-jsx/signals` types don't resolve from the linked package) — app code annotates derive callbacks explicitly and silences `any` where it mirrors lib internals (see notes in `app.ts` / `actions.ts`).
- Custom action errors: the lib's `actionError` signal is never rendered by lib components; the app uses `showActionError(explorer, msg)` (overlay box) in `actions.ts`.

## Conventions & gotchas

- Comments are detailed and explain _why_ (several non-obvious designs: hybrid DnD, watcher dirPath equality, trash-on-remove product decision). Match that style.
- Spawn OS processes detached (`detached: true, stdio: "ignore"`, `.unref()`) unless collecting output.
- Menu commands are renderer-executed (`MenuCommand` enum); the main menu only forwards clicks. `isTextEditing()` guard in `app.ts` protects against firing file commands while typing.
- Window title syncs from the renderer (`setupWindowTitleSync`) — main never computes it.
- `userData/` holds runtime state: `window-state.json`, `thumbnails/`, `trash-records.json`, `default-apps.json`.
- Trash: "delete" trashes (fs-handlers + sidecar record); the virtual `trash:///` place
  lists via `fs:listTrash`; "Empty Trash" (`fs:emptyTrash`, trash-handlers) permanently
  deletes everything — per-platform `emptyTrash()`: linux clears the FreeDesktop home
  trash (`files/` recursive + matching `info/*.trashinfo`, plus `expunged/`; missing dir
  = already empty), darwin recursively clears `~/.Trash` (no AppleScript), win32 runs
  `Clear-RecycleBin -Force` with a Shell.Application COM `Remove-Item` fallback; all
  per-item best-effort with ONE aggregated error (same style as `restoreTrash`). On
  success the handler calls `clearTrashRecords()` (trash-records.ts). The renderer
  confirms via `explorer.prompt.ask`, then refreshes manually (no watcher on `trash:///`).
- Trash DETECTION and PATH MODEL in the renderer: **every trash-derived FStat carries a VIRTUAL path** — `trash:///<name>` for items listed in the trash root, `trash:///<name>/<subpath>` for entries browsed inside a trashed directory — plus the `FStat.trash` tag (`originalPath`/`deletionTime` nullable). The fs adapter owns the virtual↔real mapping (module-level, keyed by top-level item NAME from the latest `fs:listTrash`): `resolveTrashPath()` rewrites virtual → real **in flight at every IPC boundary** (readdir/stat/copy/move/remove/exists/thumbnail and the `actions.ts` call sites for openPath/openWith/removePermanent/restoreTrash); the fs watcher bridge rewrites real trash-storage change events back to virtual dirPaths. Writes into the trash are rejected (copy/move/mkdir/touch + OS drag-in) and **all trash-derived entries are exposed read-only (`write: false`, `read: true`)** so the lib's context menu hides its built-in Delete/Cut/Rename on them; `remove()` on a trash path = permanent purge; rename within the trash anchors on the source's real location (target name isn't in the listing). Renderer actions gate via `isTrashItem()`/`isTrashLocation()` (tag-based) and resolve paths via `resolveTrashPath()` (pass-through for non-trash paths) — never send virtual paths to `window.xplorer` directly and never detect trash via path prefixes.
- README.md is the user-facing doc (features, `XPLORER_TERMINAL`, packaging, platform matrix) — update it for user-visible behavior changes; AGENT.md is the agent-facing map.
- Default apps on macOS: `choose application` cannot set the system default,
  so darwin's `openWithDialog` records the picked app per lowercased file
  extension (`default-apps.ts`; extensionless files are never recorded) and
  darwin's `openPath` (double-click) uses it while the app bundle exists,
  else `shell.openPath`. Other platforms' choosers set the real OS default, so
  their `openPath` is plain `shell.openPath` (`platform/system-default-app.ts`).
  Picking a different app via "Open With…" replaces the entry; there is no
  reset UI.
