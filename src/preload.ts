// Thin entry kept at src/preload.ts so Electron Forge's Vite plugin emits the
// bundle as `.vite/build/preload.cjs` (the output file name is derived from this
// file's basename). The actual preload bridge lives in src/preload/.
import "./preload/index";
