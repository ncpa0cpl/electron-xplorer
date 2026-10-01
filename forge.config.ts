import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePath } from "ffprobe-static";
import path from "node:path";

// App identity. `productName` ("Electron Xplorer") lives in package.json; the
// reverse-DNS bundle/app id is defined once here and reused by the makers.
const APP_ID = "com.ncpa0cpl.electron-xplorer";

// Icon set rendered from build/icons/icon.svg by `yarn icons`
// (scripts/make-icons.mjs). Linux makers take the <size>x<size>.png files in
// that directory; the .ico/.icns files are for Windows/macOS packaging.
const ICONS_DIR = path.resolve(__dirname, "build", "icons");

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
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
    // The `build/` directory only holds packaging-time assets (icons); it has
    // no runtime value, so keep it out of the asar bundle.
    ignore: [/^\/build(\/|$)/],
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
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          // src/main.ts / src/preload.ts are thin re-export entries; the output
          // bundle name (main.js / preload.js) is derived from their basenames.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
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
