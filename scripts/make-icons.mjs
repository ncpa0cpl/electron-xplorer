#!/usr/bin/env node
/**
 * Icon build script (dev-time only; not part of the packaged app).
 *
 * Renders build/icons/icon.svg (the source of truth) into:
 *   - build/icons/<N>x<N>.png   for N in 16, 32, 64, 128, 256, 512
 *     (the directory layout is what @electron-forge/maker-deb and
 *     @electron-forge/maker-rpm consume via their `icon` option)
 *   - build/icons/icon.ico      (Windows: squirrel `setupIcon`)
 *   - build/icons/icon.icns     (macOS: electron-packager `icon`)
 *
 * No npm dependencies: PNG rendering shells out to `rsvg-convert` (with an
 * ImageMagick `convert` fallback), while the ICO and ICNS containers are
 * written directly:
 *   - .ico files may embed PNG data directly (Vista+); the entry header is
 *     ICONDIR (6 bytes) followed by one 16-byte ICONDIRENTRY per image.
 *   - .icns is an even simpler container: "icns" magic + total length, then
 *     per-image chunks (4-byte type + 4-byte big-endian length incl. header,
 *     each holding one whole PNG). Types used: icp4/icp5/icp6 (16/32/64 px)
 *     and ic07/ic08/ic09 (128/256/512 px).
 *
 * Usage: node scripts/make-icons.mjs   (or `yarn icons`)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const iconsDir = path.resolve(import.meta.dirname, "..", "build", "icons");
const svgPath = path.join(iconsDir, "icon.svg");

const SIZES = [16, 32, 64, 128, 256, 512];

// ─── PNG rendering ───────────────────────────────────────────────────────────

async function renderPng(size) {
  const out = path.join(iconsDir, `${size}x${size}.png`);
  try {
    await sharp(svgPath, { density: (72 * size) / 512 })
      .resize(size, size)
      .png()
      .toFile(out);
  } catch {
    // Fallback: ImageMagick. `-background none` keeps SVG transparency.
    execFileSync("magick", [
      "-background",
      "none",
      "-density",
      String(Math.ceil(72 * size / 512)), // render at target size, not upscale
      svgPath,
      "-resize",
      `${size}x${size}`,
      out,
    ]);
  }
  return out;
}

// ─── ICO container ───────────────────────────────────────────────────────────

/**
 * ICO with embedded PNG images. Width/height bytes of 0 mean 256 px, which is
 * why sizes above 255 are clamped out of the directory entries.
 */
function writeIco(pngPaths, outPath) {
  const images = pngPaths.map((p) => ({ p, data: fs.readFileSync(p) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ p, data }, i) => {
    const size = Number(/(\d+)x\d+\.png$/.exec(path.basename(p))?.[1] ?? 256);
    const base = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, base + 0); // width
    entries.writeUInt8(size >= 256 ? 0 : size, base + 1); // height
    entries.writeUInt8(0, base + 2); // palette
    entries.writeUInt8(0, base + 3); // reserved
    entries.writeUInt16LE(1, base + 4); // color planes
    entries.writeUInt16LE(32, base + 6); // bits per pixel
    entries.writeUInt32LE(data.length, base + 8); // data size
    entries.writeUInt32LE(offset, base + 12); // data offset
    offset += data.length;
  });

  fs.writeFileSync(
    outPath,
    Buffer.concat([header, entries, ...images.map((i) => i.data)]),
  );
}

// ─── ICNS container ──────────────────────────────────────────────────────────

/** Standard ICNS chunk type per icon size. */
const ICNS_TYPES = {
  16: "icp4",
  32: "icp5",
  64: "icp6",
  128: "ic07",
  256: "ic08",
  512: "ic09",
};

function writeIcns(pngBySize, outPath) {
  const chunks = [];
  for (const [size, type] of Object.entries(ICNS_TYPES)) {
    const png = pngBySize.get(Number(size));
    if (!png) continue;
    const chunk = Buffer.alloc(8);
    chunk.write(type, 0, "ascii");
    chunk.writeUInt32BE(png.length + 8, 4); // chunk length includes this header
    chunks.push(chunk, png);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(body.length + 8, 4); // total file length
  fs.writeFileSync(outPath, Buffer.concat([header, body]));
}

// ─── Main ────────────────────────────────────────────────────────────────────

if (!fs.existsSync(svgPath)) {
  console.error(`make-icons: source SVG not found: ${svgPath}`);
  process.exit(1);
}

for (const file of fs.readdirSync(iconsDir)) {
  if (file !== "icon.svg") fs.rmSync(path.join(iconsDir, file));
}

const pngBySize = new Map();
for (const size of SIZES) {
  pngBySize.set(size, fs.readFileSync(await renderPng(size)));
}

writeIco(
  [16, 32, 64, 128, 256].map((s) => path.join(iconsDir, `${s}x${s}.png`)),
  path.join(iconsDir, "icon.ico"),
);
writeIcns(pngBySize, path.join(iconsDir, "icon.icns"));

console.log("make-icons: wrote", fs.readdirSync(iconsDir).join(", "));
