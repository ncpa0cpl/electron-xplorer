// Thin entry kept at src/main.ts so Electron Forge's Vite plugin emits the
// bundle as `.vite/build/main.js` (the output file name is derived from this
// file's basename). The actual application lives in src/main/.
import "./main/index";
