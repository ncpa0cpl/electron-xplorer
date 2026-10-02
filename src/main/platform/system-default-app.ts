import { shell } from "electron";

/**
 * Opens a path with the OS default application. Rejects with the error
 * description `shell.openPath` reports on failure.
 */
export async function openWithSystemDefault(p: string): Promise<void> {
  const error = await shell.openPath(p);
  if (error) {
    throw new Error(error);
  }
}
