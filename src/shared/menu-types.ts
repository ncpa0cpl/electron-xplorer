/**
 * Native application menu types ("menu:*" channels + commands pushed to the
 * renderer). Owned by the menu/window chunk.
 */

/**
 * Identifiers for menu commands forwarded from main to the renderer.
 *
 * Every command here is mapped onto a *publicly callable* fs-explorer API in
 * src/renderer/app.ts:
 * - "new-tab"     → explorer.newTab(activeTabLocation) (same as the lib's "+" button)
 * - "close-tab"   → explorer.closeTab(activeTabId) (ignored when it's the only tab)
 * - "refresh"     → explorer.refresh()
 * - "back"/"forward"/"up" → active tab's public `history` (back/forward/backPush)
 * - "home"        → explorer.open(homeDir)
 * - "copy"/"cut"  → explorer.clipboard.put(getActionableFiles(), "copy"|"move")
 * - "paste"       → explorer.fs.clipboardPaste(currentDir) (same as the lib's Ctrl+V)
 * - "select-all"  → active DirViewController.selectAll()
 * - "delete"      → explorer.fs.remove(...) for the actionable files (trash)
 * - "rename"      → prompt.input + explorer.fs.move (single file, like the lib's F2)
 * - "show-hidden" → active DirViewController.showHiddenFilesToggle()
 */
export type MenuCommand =
  | "new-tab"
  | "close-tab"
  | "refresh"
  | "back"
  | "forward"
  | "up"
  | "home"
  | "copy"
  | "cut"
  | "paste"
  | "select-all"
  | "delete"
  | "rename"
  | "show-hidden";

/**
 * Menu API exposed over IPC. Native menu items trigger commands that the
 * renderer maps onto explorer operations.
 */
export interface MenuApi {
  /**
   * Subscribes to native menu commands. Returns an unsubscribe function.
   */
  onMenuCommand(cb: (command: MenuCommand) => void): () => void;
}
