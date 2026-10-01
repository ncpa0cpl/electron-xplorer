import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "ffprobe-static";
import fs from "node:fs";
import path from "node:path";

// App identity. `productName` ("Electron Xplorer") lives in package.json; the
// reverse-DNS bundle/app id is defined once here and reused by the makers.
const APP_ID = "com.ncpa0cpl.electron-xplorer";

// Icon set rendered from build/icons/icon.svg by `yarn icons`
// (scripts/make-icons.mjs). Linux makers take the <size>x<size>.png files in
// that directory; the .ico/.icns files are for Windows/macOS packaging.
const ICONS_DIR = path.resolve(__dirname, "build", "icons");

// Packages the main-process bundle `require()`s at runtime in a packaged app
// (the rest of `rollupOptions.external` in vite.shared.ts is dev-only).
const RUNTIME_EXTERNALS = ["sharp"];

function findPackageDir(name: string, fromDir: string): string | undefined {
  for (let dir = fromDir;; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
    if (dir === __dirname || dir === path.dirname(dir)) {
      return undefined;
    }
  }
}

/**
 * @returns `packagerConfig.ignore`-style paths (`/node_modules/...`) of every
 * installed package in the production dependency tree of `names`. Optional
 * dependencies that are not installed (other platforms' sharp binaries) are
 * skipped.
 */
function runtimeModulePaths(names: string[]): string[] {
  const dirs = new Set<string>();
  const visit = (name: string, fromDir: string, optional: boolean) => {
    const dir = findPackageDir(name, fromDir);
    if (!dir) {
      if (optional) return;
      throw new Error(`Runtime dependency "${name}" is not installed`);
    }
    if (dirs.has(dir)) return;
    dirs.add(dir);
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      visit(dep, dir, false);
    }
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
      visit(dep, dir, true);
    }
  };
  for (const name of names) visit(name, __dirname, false);
  return [...dirs].map(
    (dir) => "/" + path.relative(__dirname, dir).split(path.sep).join("/"),
  );
}

const PACKAGED_PATHS = [
  "/.vite",
  "/package.json",
  ...runtimeModulePaths(RUNTIME_EXTERNALS),
];

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // libvips is a dylib loaded by sharp's `.node` addon via a relative
      // rpath, so both must sit side by side outside the archive.
      unpack: "**/node_modules/{sharp,@img}/**/*",
    },
    // copied to <app>/resources/ffmpeg(.exe) and <app>/resources/ffprobe(.exe)
    extraResource: [ffmpegPath as string, ffprobePath],
    // Stable, lowercase executable name. Without this the executable is
    // renamed to `productName` ("Electron Xplorer"), which breaks the deb/rpm
    // makers (they look for the binary named after the package name) and
    // Linux desktop-entry conventions.
    executableName: "electron-xplorer",
    // Human-readable app/product name is taken from package.json
    // (`productName`). Reverse-domain app id, used for e.g. the macOS bundle
    // identifier and Linux desktop-file StartupWMClass bookkeeping.
    appBundleId: APP_ID,
    // macOS bundle icon (Linux packaging ignores it; Windows squirrel uses
    // the .ico from its maker config below).
    icon: path.join(ICONS_DIR, "icon.icns"),
    // Lets Launch Services hand folders to the app (`open-file`, see
    // src/main/launch-handlers.ts). "Alternate" keeps Finder the default
    // until the user picks this app explicitly.
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: "Folder",
          CFBundleTypeRole: "Viewer",
          LSHandlerRank: "Alternate",
          LSItemContentTypes: ["public.folder"],
        },
      ],
    },
    // Setting `ignore` replaces the Vite plugin's default filter (which keeps
    // only `/.vite`), so this has to admit the Vite output plus the runtime
    // externals, and every ancestor directory leading to them.
    ignore: (file: string) =>
      !!file
      && !PACKAGED_PATHS.some(
        (kept) =>
          file === kept
          || file.startsWith(kept + "/")
          || kept.startsWith(file + "/"),
      ),
    // `dependencies` in package.json are mostly bundled by Vite and filtered
    // out above; the pruner would fail looking for them.
    prune: false,
  },
  rebuildConfig: {},
  makers: [
    // Windows installer (NSIS-based Squirrel). Only built on a Windows host;
    // the config is inert elsewhere.
    new MakerSquirrel({
      setupIcon: path.join(ICONS_DIR, "icon.ico"),
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({
      options: {
        // Single PNG copied to /usr/share/pixmaps/<name>.png (the makers'
        // typed `icon` option takes one path; the full <size>x<size>.png set
        // in build/icons/ is what icon-theme tooling would consume).
        icon: path.join(ICONS_DIR, "512x512.png"),
        categories: ["Utility", "System"],
        // `description` lands in the spec file's Summary tag,
        // `productDescription` in the %description tag.
        description: "Tabbed file explorer with previews and OS drag-and-drop",
        productDescription:
          "A tabbed file explorer with list/gallery views, filesystem watching, "
          + "media previews and OS-integrated drag-and-drop, built on Electron "
          + "and the fs-explorer library.",
        license: "MIT",
        productName: "Electron Xplorer",
      },
    }),
    new MakerDeb({
      options: {
        // Debian fields: `maintainer` is required by the .deb control file.
        maintainer: "Szymon Bretner <szymonb21@gmail.com>",
        // Single PNG copied to /usr/share/pixmaps/<name>.png (the makers'
        // typed `icon` option takes one path; the full <size>x<size>.png set
        // in build/icons/ is what icon-theme tooling would consume).
        icon: path.join(ICONS_DIR, "512x512.png"),
        categories: ["Utility", "System"],
        section: "utils",
        // `description` is the short control-file description,
        // `productDescription` the long one.
        description: "Tabbed file explorer with previews and OS drag-and-drop",
        productDescription:
          "A tabbed file explorer with list/gallery views, filesystem watching, "
          + "media previews and OS-integrated drag-and-drop, built on Electron "
          + "and the fs-explorer library.",
        productName: "Electron Xplorer",
      },
    }),
    new MakerDMG({
      name: "Xplorer",
      format: "ULFO",
      icon: path.join(ICONS_DIR, "icon.icns"),
      overwrite: true,
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          // src/main.ts / src/preload.ts are thin re-export entries; the output
          // bundle name (main.cjs / preload.cjs) is derived from their basenames.
          entry: "src/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
