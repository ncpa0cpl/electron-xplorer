import { contextBridge } from "electron";
import { dndApi } from "./dnd-api";
import { fsApi } from "./fs-api";
import { launchApi } from "./launch-api";
import { mediaApi } from "./media-api";
import { menuApi } from "./menu-api";
import { systemApi } from "./system-api";
import { trashApi } from "./trash-api";
import { watchApi } from "./watch-api";
import { windowApi } from "./window-api";

// Exposed global: `window.xplorer`
contextBridge.exposeInMainWorld("xplorer", {
  ...fsApi,
  ...systemApi,
  ...trashApi,
  ...watchApi,
  ...mediaApi,
  ...menuApi,
  ...dndApi,
  ...launchApi,
  ...windowApi,
});
