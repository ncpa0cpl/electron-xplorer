#!/usr/bin/env node
/**
 * Platform self-test (no test framework needed).
 *
 * Compiles the shared platform module (src/shared/platform) AND the main
 * platform bridge (src/main/platform - Electron-free, so it runs in plain
 * node) with esbuild into a temp dir, imports the result, and runs
 * assertions:
 *
 *  - POSIX: parity with path-browserify for a fixture list (dirname /
 *    basename / join / normalize / isAbsolute) plus the hidden-file rule.
 *  - win32: the documented edge cases - drive paths, UNC, mixed separators,
 *    dot resolution, root forms, drive-relative forms, the hidden-name
 *    approximation list.
 *  - unknown: conservative no-crash defaults.
 *  - main bridge: on the running host, accelerators / validation / URL-path
 *    conversion / app-menu / quit policy / static places sanity.
 *
 * Usage: yarn test-platform  (or: node scripts/test-platform.mjs)
 * Exit code 0 = all assertions passed.
 */
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pathBrowserify from "path-browserify";

const WORK_DIR = mkdtempSync(path.join(tmpdir(), "xplorer-platform-test-"));

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`FAIL  ${label}`);
    console.error(err?.stack ?? err);
    process.exitCode = 1;
  }
}

/** Compiles `entrySource` (importing project TS by absolute path) to ESM. */
async function compile(entrySource) {
  const entry = path.join(
    WORK_DIR,
    `entry-${Math.random().toString(36).slice(2)}.ts`,
  );
  writeFileSync(entry, entrySource);
  const outfile = entry.replace(/\.ts$/, ".mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

const projectRoot = path.resolve(import.meta.dirname, "..");

// ─── Load the modules ────────────────────────────────────────────────────────

const shared = await compile(
  `import { createPlatform } from ${
    JSON.stringify(
      path.join(projectRoot, "src/shared/platform/types.ts"),
    )
  };
export { createPlatform };`,
);
const { createPlatform } = shared;

const mainBridge = await compile(
  `import { getMainPlatform } from ${
    JSON.stringify(
      path.join(projectRoot, "src/main/platform/index.ts"),
    )
  };
import { createWin32MainPlatform } from ${
    JSON.stringify(
      path.join(projectRoot, "src/main/platform/win32.ts"),
    )
  };
export { getMainPlatform, createWin32MainPlatform };`,
);
const { getMainPlatform, createWin32MainPlatform } = mainBridge;

const posix = createPlatform("linux");
const darwin = createPlatform("darwin");
const win32 = createPlatform("win32");
const unknownPlatform = createPlatform("unknown");

// ─── POSIX: parity with path-browserify ──────────────────────────────────────

const POSIX_FIXTURES = [
  "/",
  "/a",
  "/a/b",
  "/a/b/c.txt",
  "/a/b/",
  "a",
  "a/b",
  "./a/b",
  "../a",
  "",
  "/home/owner/My Folder/My File.png",
  "/a/./b/../c",
];

console.log("\nposix: parity with path-browserify");
for (const p of POSIX_FIXTURES) {
  check(`dirname(${JSON.stringify(p)})`, () => {
    assert.equal(posix.paths.dirname(p), pathBrowserify.dirname(p));
  });
  check(`basename(${JSON.stringify(p)})`, () => {
    assert.equal(posix.paths.basename(p), pathBrowserify.basename(p));
  });
  check(`normalize(${JSON.stringify(p)})`, () => {
    assert.equal(posix.paths.normalize(p), pathBrowserify.normalize(p));
  });
  check(`isAbsolute(${JSON.stringify(p)})`, () => {
    assert.equal(posix.paths.isAbsolute(p), pathBrowserify.isAbsolute(p));
  });
}
for (
  const [a, b] of [["/a", "b"], ["a", "b"], ["/a/b/", "c"], ["/", "x"], [
    ".",
    "f.txt",
  ]]
) {
  check(`join(${JSON.stringify(a)}, ${JSON.stringify(b)})`, () => {
    assert.equal(posix.paths.join(a, b), pathBrowserify.join(a, b));
  });
}

console.log("\nposix: explicit expectations");
check("posix join(/a, b) === /a/b", () => {
  assert.equal(posix.paths.join("/a", "b"), "/a/b");
});
check("posix isAbsolute", () => {
  assert.equal(posix.paths.isAbsolute("/x"), true);
  assert.equal(posix.paths.isAbsolute("x"), false);
});
check("darwin platform shares POSIX path semantics", () => {
  assert.equal(darwin.id, "darwin");
  assert.equal(darwin.paths.join("/a", "b"), "/a/b");
  assert.equal(darwin.paths.isAbsolute("/a"), true);
});
check("posix hidden: leading dot", () => {
  assert.equal(posix.files.isHiddenName(".git"), true);
  assert.equal(posix.files.isHiddenName(".hidden-dir"), true);
  assert.equal(posix.files.isHiddenName("file.txt"), false);
  assert.equal(posix.files.isHiddenName("..dots-in-middle"), true);
});

// ─── win32 ───────────────────────────────────────────────────────────────────

console.log("\nwin32: isAbsolute");
const WIN_IS_ABSOLUTE = [
  // [input, expected]
  ["C:\\foo\\bar", true],
  ["C:/foo/bar", true],
  ["c:/foo", true],
  ["C:\\", true],
  ["\\\\server\\share\\x", true],
  ["//server/share/x", true],
  ["\\\\server\\share", true],
  ["C:", false], // drive-relative, no root
  ["C:foo", false], // drive-relative
  ["\\foo", false], // rooted, no drive (depends on per-process state)
  ["/foo", false],
  ["foo", false],
  ["", false],
];
for (const [input, expected] of WIN_IS_ABSOLUTE) {
  check(`win32.isAbsolute(${JSON.stringify(input)}) === ${expected}`, () => {
    assert.equal(win32.paths.isAbsolute(input), expected);
  });
}

console.log("\nwin32: join");
const WIN_JOIN = [
  // [segments..., expected]
  [["C:\\Users", "me"], "C:/Users/me"],
  [["C:/Users/", "me"], "C:/Users/me"],
  [
    ["C:\\Users\\me\\", "My Folder", "a b.png"],
    "C:/Users/me/My Folder/a b.png",
  ],
  [["C:\\", "foo"], "C:/foo"],
  [["C:\\a\\", "\\b"], "C:/a/b"],
  [["a", "b", "..", "c"], "a/c"], // node join parity: dots resolved
  [["a", "", "b"], "a/b"],
  [["", "a"], "a"],
  [["\\\\server\\share", "dir", "f.txt"], "//server/share/dir/f.txt"],
  [["//server/share/", "dir"], "//server/share/dir"],
];
for (const [segments, expected] of WIN_JOIN) {
  check(
    `win32.join(${JSON.stringify(segments)}) === ${JSON.stringify(expected)}`,
    () => {
      assert.equal(win32.paths.join(...segments), expected);
    },
  );
}

console.log("\nwin32: dirname");
const WIN_DIRNAME = [
  ["C:\\foo\\bar", "C:/foo"],
  ["C:\\foo\\bar\\x.txt", "C:/foo/bar"],
  ["C:\\foo", "C:/"],
  ["C:\\", "C:/"],
  ["C:/foo/bar", "C:/foo"],
  ["C:foo", "C:"], // drive-relative input keeps its device (documented)
  ["C:", "C:"],
  ["\\\\server\\share\\dir", "//server/share"],
  ["//server/share", "//server/share"],
  ["//server/share/a/b", "//server/share/a"],
  ["foo/bar", "foo"],
  ["foo", "."],
  ["/foo", "/"],
];
for (const [input, expected] of WIN_DIRNAME) {
  check(
    `win32.dirname(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
    () => {
      assert.equal(win32.paths.dirname(input), expected);
    },
  );
}

console.log("\nwin32: basename");
const WIN_BASENAME = [
  ["C:\\foo\\bar.txt", "bar.txt"],
  ["C:\\foo\\", "foo"],
  ["C:\\", ""],
  ["C:", ""],
  ["\\\\server\\share", ""],
  ["\\\\server\\share\\dir\\f.txt", "f.txt"],
  ["foo/bar.txt", "bar.txt"],
  ["", ""],
];
for (const [input, expected] of WIN_BASENAME) {
  check(
    `win32.basename(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
    () => {
      assert.equal(win32.paths.basename(input), expected);
    },
  );
}

console.log("\nwin32: normalize");
const WIN_NORMALIZE = [
  ["C:\\a\\.\\b\\..\\c\\", "C:/a/c"],
  ["C:\\..\\x", "C:/x"], // ".." at a root stays at the root
  ["C:\\foo\\\\bar", "C:/foo/bar"], // doubled separators collapse
  ["a\\..\\..\\b", "../b"],
  ["foo\\bar", "foo/bar"],
  ["\\\\server\\share\\", "//server/share"], // UNC root: no trailing sep
  ["\\\\server\\share\\a\\..", "//server/share"],
  ["/", "/"],
  ["", "."],
  ["C:", "C:"],
];
for (const [input, expected] of WIN_NORMALIZE) {
  check(
    `win32.normalize(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`,
    () => {
      assert.equal(win32.paths.normalize(input), expected);
    },
  );
}

console.log("\nwin32: hidden-name approximation");
const WIN_HIDDEN = [
  ["desktop.ini", true],
  ["Desktop.ini", true], // case-insensitive (NTFS)
  ["THUMBS.DB", true],
  ["NTUSER.DAT", true],
  ["ntuser.dat.log1", true],
  ["NTUSER.DAT{4a4c4}.tm", true],
  ["pagefile.sys", true],
  ["hiberfil.sys", true],
  ["swapfile.sys", true],
  ["AppData", true],
  ["$RECYCLE.BIN", true],
  ["System Volume Information", true],
  ["readme.txt", false],
  ["ThumbsUp.txt", false], // "thumbs.db" is an exact-name rule, not a prefix
  ["NTUSER.datMANUAL", true], // ntuser.dat* IS a prefix rule (documented)
];
for (const [input, expected] of WIN_HIDDEN) {
  check(`win32.isHiddenName(${JSON.stringify(input)}) === ${expected}`, () => {
    assert.equal(win32.files.isHiddenName(input), expected);
  });
}

// ─── unknown ─────────────────────────────────────────────────────────────────

console.log("\nunknown: conservative defaults");
check("unknown: POSIX paths, never-crash", () => {
  assert.equal(unknownPlatform.paths.join("/a", "b"), "/a/b");
  assert.equal(unknownPlatform.paths.dirname("a/b"), "a");
  assert.equal(unknownPlatform.paths.normalize(""), ".");
});
check("unknown: hides nothing", () => {
  assert.equal(unknownPlatform.files.isHiddenName(".git"), false);
  assert.equal(unknownPlatform.files.isHiddenName("anything"), false);
});

// ─── Main bridge (host = linux in CI/dev; still exercises the factory) ──────

console.log(`\nmain bridge (host platform: ${process.platform})`);
check("factory returns the host platform", () => {
  const expectedId = ["linux", "darwin", "win32"].includes(process.platform)
    ? process.platform
    : "unknown";
  assert.equal(getMainPlatform().id, expectedId);
});
check("accelerator mapping (host-specific values)", () => {
  const p = getMainPlatform();
  const isMac = p.id === "darwin";
  assert.equal(p.accelerator("new-tab"), isMac ? "CmdOrCtrl+T" : "Ctrl+T");
  assert.equal(p.accelerator("close-tab"), isMac ? "CmdOrCtrl+W" : "Ctrl+W");
  assert.equal(p.accelerator("refresh"), "F5");
  assert.equal(p.accelerator("back"), "Alt+Left");
  assert.equal(p.accelerator("forward"), "Alt+Right");
  assert.equal(p.accelerator("up"), "Alt+Up");
  assert.equal(p.accelerator("home"), "Alt+Home");
});
check("isValidAbsolutePath is platform-shaped", () => {
  const p = getMainPlatform();
  if (p.id === "win32") {
    assert.equal(p.isValidAbsolutePath("C:\\x"), true);
    assert.equal(p.isValidAbsolutePath("//srv/share"), true);
    assert.equal(p.isValidAbsolutePath("/x"), false);
  } else {
    assert.equal(p.isValidAbsolutePath("/x"), true);
    assert.equal(p.isValidAbsolutePath("C:\\x"), false);
    assert.equal(p.isValidAbsolutePath("x"), false);
  }
});
check("protocolPathToAbsolute: posix identity / win32 drive strip", () => {
  const p = getMainPlatform();
  if (p.id === "win32") {
    assert.equal(
      p.protocolPathToAbsolute("/C:/Users/me/a.png"),
      "C:/Users/me/a.png",
    );
    assert.throws(() => p.protocolPathToAbsolute("relative/x"));
  } else {
    assert.equal(
      p.protocolPathToAbsolute("/home/owner/a.png"),
      "/home/owner/a.png",
    );
    assert.throws(() => p.protocolPathToAbsolute("relative/x"));
  }
});
check("app menu + quit policy", () => {
  const p = getMainPlatform();
  assert.equal(p.usesAppMenu(), p.id === "darwin");
  assert.equal(p.quitAfterAllWindowsClosed(), p.id !== "darwin");
});

console.log("\nwin32 main bridge (exercised directly; no Windows needed)");
const win32Main = createWin32MainPlatform();
check(
  "win32 validation: drives and UNC accepted, POSIX-relative rejected",
  () => {
    assert.equal(win32Main.isValidAbsolutePath("C:\\Users\\me"), true);
    assert.equal(win32Main.isValidAbsolutePath("C:/Users/me"), true);
    assert.equal(win32Main.isValidAbsolutePath("\\\\server\\share"), true);
    assert.equal(win32Main.isValidAbsolutePath("//server/share"), true);
    assert.equal(win32Main.isValidAbsolutePath("/Users/me"), false);
    assert.equal(win32Main.isValidAbsolutePath("relative/x"), false);
    assert.equal(win32Main.isValidAbsolutePath(""), false);
  },
);
check(
  "win32 protocolPathToAbsolute: drive strip + UNC verbatim + rejects",
  () => {
    assert.equal(
      win32Main.protocolPathToAbsolute("/C:/Users/me/a.png"),
      "C:/Users/me/a.png",
    );
    assert.equal(
      win32Main.protocolPathToAbsolute("//server/share/a.png"),
      "//server/share/a.png",
    );
    assert.throws(() => win32Main.protocolPathToAbsolute("relative/x"));
    assert.throws(() => win32Main.protocolPathToAbsolute("/plain"));
  },
);
check("win32 accelerators: Ctrl", () => {
  assert.equal(win32Main.accelerator("new-tab"), "Ctrl+T");
  assert.equal(win32Main.accelerator("close-tab"), "Ctrl+W");
  assert.equal(win32Main.usesAppMenu(), false);
  assert.equal(win32Main.quitAfterAllWindowsClosed(), true);
});
try {
  const places = await win32Main.getStaticPlaces();
  assert.ok(Array.isArray(places), "places not an array");
  for (const place of places) {
    assert.match(
      place.path,
      /^[A-Z]:\\$|^C:/i,
      `win32 place path not drive-shaped: ${place.path}`,
    );
  }
  passed++;
  console.log(
    `  ok  win32 static places are drive/profile shaped (${places.length} here, 0 on linux)`,
  );
} catch (err) {
  console.error("FAIL  win32 static places");
  console.error(err?.stack ?? err);
  process.exitCode = 1;
}
try {
  const places = await getMainPlatform().getStaticPlaces();
  assert.ok(Array.isArray(places) && places.length > 0, "no places returned");
  for (const place of places) {
    assert.ok(
      place.id && place.label && place.path,
      `bad place ${JSON.stringify(place)}`,
    );
  }
  const platform = createPlatform(getMainPlatform().id);
  for (const place of places) {
    assert.equal(
      platform.paths.isAbsolute(place.path),
      true,
      `place path not absolute on its own platform: ${place.path}`,
    );
  }
  passed++;
  console.log(
    `  ok  static places are absolute and labeled (${places.length} places)`,
  );
} catch (err) {
  console.error("FAIL  static places are absolute and labeled");
  console.error(err?.stack ?? err);
  process.exitCode = 1;
}

// ─── Round trips ─────────────────────────────────────────────────────────────

console.log("\nround trips");
check("posix: join(dirname(p), basename(p)) restores normalized p", () => {
  for (const p of ["/a/b", "/a/b/c.txt", "a/b", "/x"]) {
    const restored = posix.paths.join(
      posix.paths.dirname(p),
      posix.paths.basename(p),
    );
    assert.equal(restored, pathBrowserify.normalize(p));
  }
});
check("win32: join(dirname(p), basename(p)) restores normalized p", () => {
  for (const p of ["C:/a/b", "C:/a/b/c.txt", "//server/share/dir/f.txt"]) {
    const restored = win32.paths.join(
      win32.paths.dirname(p),
      win32.paths.basename(p),
    );
    assert.equal(
      restored,
      win32.paths.normalize(p),
      `p=${p} restored=${restored}`,
    );
  }
});

// ─── Done ────────────────────────────────────────────────────────────────────

rmSync(WORK_DIR, { recursive: true, force: true });
console.log(
  `\n${passed} assertions passed${process.exitCode ? " (WITH FAILURES)" : ""}`,
);
