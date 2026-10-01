# Electron Xplorer

A cross-platform, tabbed **file explorer** built on **Electron 42** (Electron
Forge + Vite) and the
[fs-explorer](https://github.com/ncpa0cpl/fs-explorer) UI library
(`@ncpa0cpl` / Szymon Bretner).

![icon](build/icons/256x256.png)

## Features

- **Tabs** — browse multiple directories side by side in one window
  (`Ctrl+T` / `Ctrl+W`, native menu or the toolbar "+" button).
- **List and gallery views** — the library's dense list view plus a
  thumbnail gallery; per-tab view state.
- **File operations** — new folder/file, rename (single + bulk rename
  overlay), copy/cut/paste with overwrite prompting, delete **to the OS
  trash** (permanent delete available from the context menu). The trash is
  browsable at the virtual `trash:///` place, with "Restore" per item and an
  "Empty Trash" action on the trash root (asks first; **permanently deletes
  ALL items**).
- **Shell integration** — double-click opens a file with the OS default
  application; "Open With…" brings up the OS-native application-chooser
  dialog for a file (xdg-desktop-portal `OpenFile` with `ask` via a
  python3/GLib helper on Linux, `rundll32 shell32.dll,OpenAs_RunDLLW` on
  Windows, AppleScript `choose application` on macOS); "Open in Terminal"
  (with `$TERMINAL` support, per-terminal argument conventions, and a
  custom `$XPLORER_TERMINAL` command-line override — see "Open in Terminal"
  below); a left
  **places pane** (Home, Desktop, Documents, Downloads, Music, Pictures,
  Videos, Filesystem root).
- **Live filesystem watching** — every browsed directory gets one
  non-recursive `fs.watch` subscription in the main process; change events
  are debounced, LRU-capped (64 dirs) and pushed to the renderer, so tabs
  refresh themselves when files change on disk.
- **Thumbnails & media streaming** — raster images are thumbnailed by
  `nativeImage` in the main process; video / GIF / WebP / AVIF / SVG fall
  back to a renderer-side canvas pass; both share one disk cache in
  `userData/thumbnails` keyed by `sha256(path:mtime:size)`. Full-size
  previews stream over the custom `xmedia://` protocol with full HTTP Range
  support (seekable `<video>`).
- **OS drag-and-drop, both directions** — drag entries **out** to any
  system target via `webContents.startDrag`; drag files **in** from a
  system file manager and they are copied (internal drags between tabs
  move).
- **Native application menu** with shortcuts (new/close tab, refresh, show
  hidden, back/forward/up/home, copy/cut/paste/select-all, delete, rename)
  mapped onto the fs-explorer public API.
- **Window bounds persistence** — size/position/maximized state restored
  across restarts (`userData/window-state.json`); deliberately never
  persists the last visited directory (the app always opens in `$HOME`).

## Open in Terminal

"Open in Terminal" spawns a terminal emulator in the browsed directory.
Built-in detection (first match wins):

- **Linux** — `$TERMINAL` when it names an executable (a bare binary;
  spawned directly, no shell, with the directory flag of known emulators),
  then a detection table: `gnome-terminal`, `konsole`, `xfce4-terminal`,
  `x-terminal-emulator`, `alacritty`, `kitty`, `tilix`, `foot`.
- **macOS** — `open -a iTerm <dir>` when iTerm is installed, else
  `open -a Terminal <dir>`.
- **Windows** — `wt.exe -d <dir>`, then `powershell.exe`, then `cmd.exe`.

### `XPLORER_TERMINAL` — custom terminal override

Setting the **`XPLORER_TERMINAL`** environment variable overrides _all_ of
the above on _every_ platform (including Linux `$TERMINAL`). The value is a
**full command line template** that the app runs through the system shell
(`/bin/sh` on Linux/macOS, `cmd.exe` on Windows):

- If the value contains the `{dir}` placeholder, **every** occurrence is
  replaced with the target directory, shell-quoted for the platform
  (POSIX single-quote escaping; Windows double-quote escaping).
- If the value contains **no** `{dir}` placeholder, the quoted directory is
  appended as the final argument.

Examples:

```sh
# Linux / macOS
XPLORER_TERMINAL='wezterm start --cwd {dir}' electron-xplorer
XPLORER_TERMINAL='kitty --directory {dir}' electron-xplorer
XPLORER_TERMINAL='alacritty --working-directory' electron-xplorer  # {dir} appended
```

```powershell
# Windows (PowerShell)
$env:XPLORER_TERMINAL = 'wt -d {dir}'
$env:XPLORER_TERMINAL = '"C:\Program Files\WezTerm\wezterm-gui.exe" start --cwd {dir}'
```

Note the difference to Linux `$TERMINAL`: that variable holds a **single
binary name** and is spawned directly without a shell, while
`XPLORER_TERMINAL` is a **whole command line** evaluated by the shell — and
it wins over `$TERMINAL` and every built-in detection path.

## Development setup

### Prerequisites

- **Node.js** (a current LTS; any Node ≥ 18 works)
- **Yarn 1 (classic)** — the project uses Yarn 1 workspaces-style
  `yarn link` for the UI library (see below)
- The **fs-explorer** library checked out and built:
  `yarn && yarn build` inside the fs-explorer checkout (this produces
  `dist/esm` + `dist/types`, which Vite and TypeScript consume)

### Wiring up the linked fs-explorer

Today the app consumes fs-explorer through **`yarn link`**:

```sh
# one-time, inside the fs-explorer checkout (after `yarn build`):
yarn link

# inside electron-xplorer:
yarn link fs-explorer   # or: yarn install && yarn link fs-explorer
```

`node_modules/fs-explorer` then symlinks to the live checkout, so library
edits show up here after a rebuild of the lib's `dist/`.

> **Note on the `start` script:** `yarn start` runs
> `rm -rf node_modules/.vite && electron-forge start`. The `rm` is a
> deliberate cache-bust — Vite's optimizer cache (`.vite/`) can go stale
> when the _linked_ fs-explorer (or its vanilla-jsx dependency) changes on
> disk without a version bump, and a stale cache surfaces as confusing
> runtime errors. JSON can't carry comments, so this is documented here.
> (Once fs-explorer comes from npm and stops mutating between runs, the
> cache-bust can be dropped.)

### Scripts

| Script               | What it does                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `yarn start`         | Cache-busts `.vite/` and starts the app in dev mode (Vite HMR for the renderer)                                         |
| `yarn package`       | Builds the Vite bundles and packages the app for the current platform (asar + fuses)                                    |
| `yarn make`          | Package + produce distributables for every configured maker that works on this host                                     |
| `yarn make:deb`      | Debian `.deb` (any Linux host with `dpkg-deb`)                                                                          |
| `yarn make:rpm`      | RPM (needs `rpmbuild` on the host)                                                                                      |
| `yarn make:appimage` | Self-contained Linux `.AppImage` (host arch; `APPIMAGE_ARCH=arm64` to cross-package; fetches `appimagetool` if missing) |
| `yarn make:macos`    | macOS `.zip` per arch — **on a Mac** for signable artifacts, or cross-packaged unsigned from Linux/CI                   |
| `yarn make:dmg`      | macOS `.dmg` (host arch; **macOS host only** — needs `hdiutil`)                                                         |
| `yarn icons`         | Re-renders `build/icons/*` from `build/icons/icon.svg` (PNG set + `.ico` + `.icns`)                                     |
| `yarn lint`          | ESLint over all TypeScript                                                                                              |
| `yarn test-platform` | Runs the platform self-test suite (see "Platform support" below)                                                        |
| `npx tsc --noEmit`   | Type-check in strict mode                                                                                               |
| `yarn check`         | Both of the above, in one command                                                                                       |

Set **`ELECTRON_XPLORER_DEVTOOLS=1`** to open DevTools automatically at
startup (`yarn start` keeps them closed otherwise, which keeps automated
screenshot runs clean):

```sh
ELECTRON_XPLORER_DEVTOOLS=1 yarn start
```

## Packaging

`forge.config.ts` configures:

- `productName: "Electron Xplorer"` (in package.json) and a stable lowercase
  `executableName: "electron-xplorer"` (required by the deb/rpm makers and
  Linux desktop conventions), plus the reverse-DNS app id
  **`com.bretner.electron-xplorer`**.
- **Icons** — the single source of truth is `build/icons/icon.svg`; run
  `yarn icons` to regenerate the PNG set (16–512 px), `icon.ico` (Windows)
  and `icon.icns` (macOS). The script needs no npm dependencies: it renders
  PNGs with `rsvg-convert` (ImageMagick `convert` fallback) and writes the
  ICO/ICNS containers directly in pure JS. Linux makers consume the 512px
  PNG (`/usr/share/pixmaps/electron-xplorer.png`); `packagerConfig.icon`
  points at the `.icns` and the squirrel maker at the `.ico`.
- **Makers** — squirrel (Windows), zip and dmg (macOS), deb and rpm (Linux)
  with maintainer/categories/description/section metadata.
- **Packaged files** — Vite bundles everything except `sharp`, so the asar
  holds only `.vite/` plus `sharp` and its installed dependencies (resolved
  from `node_modules` at config load). `sharp` and `@img/*` are unpacked to
  `app.asar.unpacked/` because the native addon loads libvips via a relative
  rpath. Only the host's `@img/sharp-<os>-<arch>` binaries are installed by
  default; building for another arch needs them installed too (see
  https://sharp.pixelplumbing.com/install#cross-platform).

```sh
yarn package              # → out/Electron Xplorer-linux-x64/
yarn make:deb             # → out/make/deb/x64/*.deb
yarn make:rpm             # → out/make/rpm/x64/*.rpm   (needs rpmbuild)
yarn make:appimage        # → out/make/appimage/electron-xplorer-x86_64.AppImage
yarn make:macos           # → out/make/zip/darwin/<arch>/*.zip
yarn make:dmg             # → out/make/Electron Xplorer-<version>-<arch>.dmg
```

### macOS distribution notes

`yarn make:macos` produces an **unsigned** zip that macOS Gatekeeper blocks
("unidentified developer"). For a real distributable, run on a Mac and:

```sh
codesign --deep --force --options runtime \
  --sign "Developer ID Application: YOU (TEAMID)" \
  "out/Electron Xplorer-darwin-arm64/Electron Xplorer.app"
xcrun notarytool submit <zipped-app> --apple-id … --team-id … --password …
xcrun stapler staple "Electron Xplorer.app"
```

`yarn make:dmg` wraps the packaged app in a DMG, equally unsigned unless the
app was signed first (e.g. via `packagerConfig.osxSign`).

Building from Linux/CI is supported for testing only (Packager downloads the
darwin Electron binaries); the resulting zip runs on machines with Gatekeeper
exceptions. When the host lacks the `zip` CLI, the script transparently uses a
7z-backed shim (`build/tools/bin/zip`).

### Opening folders / default folder handler (macOS)

The app runs as a single instance and opens every folder it is handed in a
new tab: `electron-xplorer <dir>…` from a terminal, a second launch, or, on
macOS, Launch Services (the bundle declares `public.folder` with
`LSHandlerRank: Alternate`, so it shows up under Finder's "Open With" without
taking over by default):

```sh
open -a "Electron Xplorer" ~/Documents
```

To make it the default for folders opened outside Finder (`open <dir>`, Dock
stacks, other apps' "open folder" actions): macOS 26 rejects changing the
`public.folder` handler through the Launch Services API (`duti -s …` and
`NSWorkspace.setDefaultApplication` both fail with `-50`), so the override has
to go straight into Launch Services' preferences, then log out and back in:

```sh
defaults export com.apple.LaunchServices/com.apple.launchservices.secure ~/launchservices-backup.plist
defaults write com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers -array-add \
  '{LSHandlerContentType="public.folder";LSHandlerRoleAll="com.ncpa0cpl.electron-xplorer";}'
# back to Finder (also reverts any other handler changes made since the backup):
defaults import com.apple.LaunchServices/com.apple.launchservices.secure ~/launchservices-backup.plist
```

Finder itself (Desktop, its own windows, Open/Save dialogs) is unaffected, and
"Reveal in Finder" actions still go to Finder.

### Arch & derivatives

There is no pacman maker in Electron Forge; the idiomatic route is an AUR
`PKGBUILD` that uses the **system** `electron` package:

```sh
build() {
  cd "$srcdir/electron-xplorer"
  yarn install --frozen-lockfile
  npx electron-forge package
}
package() {
  install -Dm644 "out/Electron Xplorer-linux-x64/resources/app.asar" \
    "$pkgdir/usr/lib/electron-xplorer/app.asar"
  install -Dm755 /dev/stdin "$pkgdir/usr/bin/electron-xplorer" <<'EOF'
#!/bin/sh
exec /usr/bin/electron /usr/lib/electron-xplorer/app.asar "$@"
EOF
  install -Dm644 build/icons/512x512.png \
    "$pkgdir/usr/share/pixmaps/electron-xplorer.png"
  # + a .desktop entry pointing Exec=electron-xplorer
}
```

(The security fuses baked into the bundled Electron binary don't apply to the
system one — standard and accepted for distro packaging.) The `make:appimage`
artifact also works on Arch directly, no packaging required.

## Platform support

### Status matrix

| Capability                                                 | Linux    | Windows                                  | macOS         |
| ---------------------------------------------------------- | -------- | ---------------------------------------- | ------------- |
| Path handling (joins, absolute checks, drive letters, UNC) | ✓ tested | ✓ implemented                            | ✓ implemented |
| Terminal integration ("Open in Terminal")                  | ✓ tested | ✓ implemented                            | ✓ implemented |
| Static places (left pane)                                  | ✓ tested | ✓ implemented                            | ✓ implemented |
| Menu accelerators / app menu                               | ✓ tested | ✓ implemented                            | ✓ implemented |
| Hidden-file semantics                                      | ✓ tested | ✓ implemented (name-based approximation) | ✓ implemented |
| Trash (browse + restore + empty)                           | ✓ tested | ✓ best-effort                            | ✓ best-effort |

Honest caveat: this project is developed on **Linux**. Linux is exercised
continuously (including the automated screenshot/interaction runs). The
**Windows and macOS implementations are complete and covered by
`yarn test-platform` (a plain-node self-test suite — no GUI needed), but
they have never been executed on a real Windows/macOS host**: terminal
spawn flags, drive enumeration and the `Cmd` menu behavior follow each
platform's documented conventions and are annotated in the source, yet a
first run on real hardware should be treated as the actual verification.

### The platform-abstraction rule

Every platform-dependent behavior lives behind an interface with one
implementation per platform, selected by a **single factory**. Call sites
never write `if (windows) ... else ...`; they read
`platform.doStuff()`. The **only** platform-conditional code in the
codebase is:

- `src/shared/platform/types.ts` — `createPlatform(id)`, the renderer-side
  factory (`switch` over the `PlatformId` the renderer receives from the
  main process via `system:getPlatformInfo`; the renderer never detects
  the platform itself);
- `src/main/platform/index.ts` — `getMainPlatform()`, the main-process
  factory (`switch (process.platform)`).

Two layers:

1. **`Platform`** (shared, `src/shared/platform/`) — pure, host-independent
   behavior usable in both processes: POSIX path handling (delegating to
   path-browserify), a dependency-free win32 path implementation
   (drive letters, UNC, both separators on input, forward-slash canonical
   output — chosen because fs-explorer's internal `Path` parses
   POSIX-style strings and every Node fs API on Windows accepts forward
   slashes), conservative defaults for an unknown platform, and the
   hidden-file convention (POSIX: leading dot; win32: a documented
   name-based approximation — `$RECYCLE.BIN`, `desktop.ini`,
   `NTUSER.DAT*`, … — because Node's fs does not expose Windows' real
   hidden attribute).
2. **`MainPlatform`** (main process, `src/main/platform/`) —
   process-level behavior: static places, terminal spawning, absolute-path
   validation for IPC/protocol/drag arguments, `xmedia://` URL path
   decoding, menu accelerators (`Ctrl` vs `CmdOrCtrl`), the macOS app-menu
   flag and the quit-when-last-window-closes policy. Terminal order: an
   `$XPLORER_TERMINAL` command-line override when set, then `$TERMINAL` +
   the usual Linux emulators; `open -a iTerm/Terminal` on
   macOS; `wt.exe` → `powershell.exe` → `cmd.exe` on Windows (quoting
   choices documented in `src/main/platform/win32.ts`).

### Adding a platform

1. Implement the pure **`Platform`** interface in `src/shared/platform/`
   (paths + hidden-file rule) and export a creator.
2. Implement **`MainPlatform`** in `src/main/platform/` (terminal, places,
   validation, accelerators, menu/quit policy).
3. Add the id to `PlatformId` and **one `case` in each of the two factory
   switches** (`createPlatform`, `getMainPlatform`), plus the preload/IPC
   plumbing if the id needs to reach the renderer (it flows through
   `system:getPlatformInfo` automatically).
4. Extend `scripts/test-platform.mjs` (`yarn test-platform`).

### Drag-and-drop semantics (hybrid model)

- **Inside the window**: drags are fully emulated by fs-explorer
  (mouse-event based) — highlight, cross-tab drops, **move** semantics.
  No OS drag session exists for these.
- **Pointer leaves the window** (button still held): the in-progress drag
  is handed to the OS mid-gesture via `webContents.startDrag`
  ("system:drag-out", fire-and-forget), so the drop target can be any
  external application.
- **Dropping back into this app**: an OS-handed drag is indistinguishable
  from a drag from any external file manager, so it lands as a **copy**
  (via the OS drag-in path) — same behavior as real file managers.

## Architecture

```
src/
├── main.ts                 thin entry (bundle basename → .vite/build/main.js)
├── preload.ts              thin entry (→ .vite/build/preload.js)
├── main/                   main process
│   ├── index.ts            app lifecycle, window creation, devtools opt-in
│   ├── ipc.ts              typed `ipcMain.handle` wrapper w/ arg validation
│   ├── fs-handlers.ts      "fs:*" channels (batched readdirStat, copy/move/
│   │                       trash, mkdir/touch, readFile, …)
│   ├── watcher-handlers.ts fs.watch service (LRU-capped, debounced events)
│   ├── media-handlers.ts   "media:*" channels (thumbnails, cache)
│   ├── media-protocol.ts   "xmedia://" streaming protocol (Range support)
│   ├── system-handlers.ts  "system:*" channels (places, open-with, title)
│   ├── platform/           main-process platform bridge (see "Platform
│   │                       support" below): index.ts = THE single
│   │                       process.platform switch, one impl per platform
│   ├── drag-handlers.ts    "system:drag-out" → webContents.startDrag
│   ├── menu-handlers.ts    native menu → "menu:command" broadcasts
│   ├── launch-handlers.ts  folders from argv / second launch / macOS
│   │                       `open-file` → "launch:*" (single instance)
│   └── window-state.ts     bounds-only window persistence
├── preload/                contextBridge API (window.xplorer)
│   ├── index.ts            merges fs/system/watch/media/menu/dnd/launch namespaces
│   └── *-api.ts            one module per channel group
├── renderer/
│   ├── index.ts            bootstrap entry
│   ├── app.ts              Explorer wiring + native-menu command mapping
│   ├── platform.ts         renderer platform holder (set once at bootstrap)
│   ├── fs-adapter.ts       fs-explorer `Filesystem` impl over window.xplorer
│   ├── actions.ts          open-with-system, open-in-terminal, permanent
│   │                       delete, OS drag-in handler, window-title sync
│   ├── drag-out.ts         nativeDragStart handler (paths → main)
│   └── media-thumbs.ts     canvas thumbnail fallback (videos/GIF/WebP/…)
└── shared/                 types shared across processes (channel groups)
    └── platform/           pure-JS platform module (paths, hidden-file
                            rule) + the renderer-side factory switch
```

**The `Filesystem` adapter boundary.** fs-explorer is UI-only; it performs
all real I/O through a `Filesystem` interface passed to its constructor.
This app implements that interface in `src/renderer/fs-adapter.ts` on top
of the IPC bridge — so the library never touches Node APIs directly and the
same UI could be driven by any other storage backend.

**IPC channel groups** (see `src/shared/`):

- `fs:*` — request/response file operations (the handler wrapper validates
  absolute-path arguments and rejects null bytes);
- `system:*` — home dir, static places, platform id (`getPlatformInfo`),
  open-with-default-app, open-in-terminal, window title;
- `media:*` — media streaming URLs and the shared thumbnail disk cache;
- `fs:change` / `menu:command` — main→renderer pushes (directory watchers,
  native menu commands);
- `launch:*` — folders to open: pulled once at startup (the first becomes the
  initial tab instead of the home directory), later ones pushed as new tabs;
- `system:drag-out` — fire-and-forget renderer→main drag session start
  (must run inside a `dragstart` user gesture).

## The future: fs-explorer from npm

The library is currently consumed via `yarn link`. Once **fs-explorer is
published to npm**, switch to a normal registry dependency:

```sh
# inside electron-xplorer:
yarn unlink fs-explorer
yarn add fs-explorer            # replaces "yarn link fs-explorer"
```

No structural changes are expected: the app already aliases every
`@ncpa0cpl/vanilla-jsx` entry point to a single physical copy in
`vite.shared.ts` (which keeps exactly one signals singleton in the bundle).
Two housekeeping items on the switch:

- align the app's `@ncpa0cpl/vanilla-jsx` dependency + `resolutions` pin
  with whatever version the published fs-explorer requires (the linked
  checkout currently builds against `^0.0.1-alpha.52` while the app
  resolves `^0.0.1-alpha.51`);
- the `rm -rf node_modules/.vite` cache-bust in the `start` script can then
  be removed, since the dependency stops mutating between runs (see the
  note above).

## License

MIT
