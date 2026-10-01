import { ipcRenderer } from "electron";
import type {
  TrashApi,
  TrashEntryInfo,
  TrashRestoreItem,
} from "../shared/fs-types";

/**
 * Preload-side trash operations. Each function maps 1:1 to an "fs:*" IPC
 * channel registered in `src/main/trash-handlers.ts`.
 */
export const trashApi: TrashApi = {
  listTrash: () =>
    ipcRenderer.invoke("fs:listTrash") as Promise<TrashEntryInfo[]>,
  restoreTrash: (items: TrashRestoreItem[]) =>
    ipcRenderer.invoke("fs:restoreTrash", items) as Promise<void>,
  emptyTrash: () => ipcRenderer.invoke("fs:emptyTrash") as Promise<void>,
};
