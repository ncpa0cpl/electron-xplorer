import { contextBridge } from "electron";
import { dndApi } from "./dnd-api";
import { fsApi } from "./fs-api";
import { mediaApi } from "./media-api";
import { menuApi } from "./menu-api";
import { systemApi } from "./system-api";
import { watchApi } from "./watch-api";

// Exposed global: `window.xplorer`
contextBridge.exposeInMainWorld("xplorer", {
  ...fsApi,
  ...systemApi,
  ...watchApi,
  ...mediaApi,
  ...menuApi,
  ...dndApi,
});
