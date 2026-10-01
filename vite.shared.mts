import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserConfig } from "vite";

/**
 * `@ncpa0cpl/vanilla-jsx` must always be bundled exactly once, regardless of
 * which dependency imports it.
 *
 * The `fs-explorer` dependency is `yarn link`-ed, so by default its imports of
 * `@ncpa0cpl/vanilla-jsx` resolve to the copy inside the linked package's own
 * `node_modules`, while other dependencies (e.g. `adwaveui`) resolve their own
 * copies. This results in the package - and most importantly the `signals`
 * singleton - being included in the bundle multiple times, breaking signal
 * identity across module boundaries.
 *
 * These resolve options alias every `@ncpa0cpl/vanilla-jsx` entry point to a
 * single physical copy of the package, so that all imports (including deep
 * imports like `/signals` and `/jsx-runtime`) resolve to the same files.
 */
export function vanillaJsxResolveConfig(): Pick<
  UserConfig,
  "resolve" | "build"
> {
  const vanillaJsxRoot = findVanillaJsxRoot();
  const esmDist = path.join(vanillaJsxRoot, "dist", "esm");

  return {
    build: {
      rollupOptions: {
        external: [
          "ffmpeg-static",
          "ffprobe-static",
          "sharp",
          /^@img\/sharp-.*/,
        ],
      },
    },
    resolve: {
      dedupe: ["@ncpa0cpl/vanilla-jsx"],
      alias: [
        // Order matters - more specific paths must come first.
        {
          find: "@ncpa0cpl/vanilla-jsx/jsx-dev-runtime",
          replacement: path.join(esmDist, "jsx-dev-runtime.mjs"),
        },
        {
          find: "@ncpa0cpl/vanilla-jsx/jsx-runtime",
          replacement: path.join(esmDist, "jsx-runtime.mjs"),
        },
        {
          find: "@ncpa0cpl/vanilla-jsx/signals",
          replacement: path.join(esmDist, "signals.mjs"),
        },
        {
          find: "@ncpa0cpl/vanilla-jsx",
          replacement: path.join(esmDist, "index.mjs"),
        },
      ],
    },
  };
}

function findVanillaJsxRoot(): string {
  // Prefer the project-local copy, if one is installed (or yarn link-ed).
  const local = path.resolve(
    __dirname,
    "node_modules",
    "@ncpa0cpl",
    "vanilla-jsx",
  );
  if (fs.existsSync(local)) {
    return fs.realpathSync(local);
  }
  // Fall back to the yarn global link directory.
  const linked = path.join(
    os.homedir(),
    ".config",
    "yarn",
    "link",
    "@ncpa0cpl",
    "vanilla-jsx",
  );
  if (fs.existsSync(linked)) {
    return fs.realpathSync(linked);
  }
  throw new Error(
    "Could not find @ncpa0cpl/vanilla-jsx. "
      + "Run `yarn link @ncpa0cpl/vanilla-jsx` in the project root.",
  );
}
