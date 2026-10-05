/**
 * Filesystem watching types ("watch:*" channels + events pushed to the
 * renderer). Owned by the file-watching chunk.
 */

/** Event pushed from main to the renderer when a watched directory changes. */
export interface FsChangeEvent {
  /**
   * Absolute path of the directory in which something changed. This is the
   * exact path string main was given when the directory was browsed (via the
   * `fs:readdirStat` hook), so the renderer can forward it verbatim to
   * fs-explorer's `onChange` callback, which compares it against tab history
   * entries (segment-wise `Path.equals`).
   */
  readonly dirPath: string;
}

/**
 * Watching API exposed over IPC. The main process keeps the actual
 * `fs.watch` subscriptions; the renderer declares WHICH directories to watch
 * (the dirs open in the app's tabs, pushed by fs-explorer's
 * `Filesystem.setWatchedDirs`) and only receives pushed events back.
 */
export interface WatchApi {
  /**
   * Subscribes to filesystem change events. Returns an unsubscribe
   * function.
   */
  onFsChange(cb: (event: FsChangeEvent) => void): () => void;
  /**
   * Declares the exact set of directories the calling window has open in
   * its tabs (real native paths). Main watches the UNION of all windows'
   * declarations: a dir's watcher is closed only when no window declares it
   * anymore. Fire-and-forget ("watch:setDirs" channel).
   */
  setWatchedDirs(dirs: readonly string[]): void;
}
