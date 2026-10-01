/**
 * Folder-open request types ("launch:*" channels). Requests come from the
 * command line, from a second launch of the app, and on macOS from Launch
 * Services ("Open With", `open -a`, the default folder handler).
 */

export interface LaunchApi {
  /**
   * Hands over the folders requested before this window was ready for them,
   * and makes this window the target of all later requests.
   *
   * Later requests are delivered only to `onOpenFolders` subscribers that
   * exist when they arrive, so subscribe before yielding to the event loop
   * after this resolves.
   *
   * @returns Absolute paths of existing directories, oldest request first.
   */
  takeLaunchFolders(): Promise<string[]>;
  /**
   * Subscribes to folder-open requests made after `takeLaunchFolders`.
   * Returns an unsubscribe function.
   */
  onOpenFolders(cb: (folders: readonly string[]) => void): () => void;
}
