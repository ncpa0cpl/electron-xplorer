import { app, dialog, Menu, webContents } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/menu-types";
import { getMainPlatform } from "./platform";
import type { MenuAcceleratorKey } from "./platform/types";

/**
 * Native application menu.
 *
 * Menu items that need a renderer action broadcast a `MenuCommand` to every
 * live webContents ("menu:command" channel); src/renderer/app.ts maps each
 * command onto fs-explorer's public Explorer API.
 *
 * ── Accelerator double-fire policy ──────────────────────────────────────────
 * Electron menu accelerators intercept key events *before* the renderer sees
 * them, so an accelerated item and the lib's internal key handler can never
 * both fire for the same keypress. Still, we deliberately do NOT accelerate
 * keys the lib already binds in the renderer (src/explorer.ts
 * `globalKeyDownHandler`): Ctrl+C/X/V/A, plain Delete and F2. Reasons:
 * 1. The lib's handlers carry a focus guard (skip when a text field/control
 *    inside the explorer window is focused) which a menu accelerator would
 *    bypass (menu accelerators fire regardless of renderer focus, e.g. Ctrl+C
 *    mid-rename would silently put files on the file clipboard).
 * 2. `role: "copy"`-style items act on the webContents' *text* selection and
 *    ship with their own accelerators - they can never drive the lib's file
 *    clipboard controller, which is a separate mechanism. So clipboard file
 *    operations are click-only menu items backed by renderer commands
 *    (explorer.clipboard.put / explorer.fs.clipboardPaste), and no role-based
 *    clipboard items are registered at all.
 * The lib does NOT bind plain F5 (its refresh binding is Ctrl+F5), nor
 * Ctrl+T/Ctrl+W/Alt+Arrow navigation - those accelerators are ours.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Broadcasts a menu command to every live webContents (all windows/tabs). */
function sendMenuCommand(command: MenuCommand): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) {
      wc.send("menu:command", command);
    }
  }
}

/** Click handler factory for renderer-backed menu items. */
function command(commandName: MenuCommand): () => void {
  return () => sendMenuCommand(commandName);
}

/** Builds and registers the application menu (must run after `ready`). */
function buildMenuTemplate(): MenuItemConstructorOptions[] {
  // Accelerators come from the main platform bridge: Cmd on darwin (via
  // "CmdOrCtrl"), Ctrl on linux/win32; see src/main/platform/*.ts.
  const accel = (key: MenuAcceleratorKey): string =>
    getMainPlatform().accelerator(key);
  // Dev-only items (Reload App / Toggle DevTools) are only present when
  // DevTools were requested via the environment, mirroring the
  // ELECTRON_XPLORER_DEVTOOLS gate for auto-opening them in main/index.ts.
  const isDev = process.env.ELECTRON_XPLORER_DEVTOOLS === "1";
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "New Tab",
          accelerator: accel("new-tab"),
          click: command("new-tab"),
        },
        {
          label: "Close Tab",
          accelerator: accel("close-tab"),
          click: command("close-tab"),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        // Click-only items: the lib binds Ctrl+C/X/V/A internally (with its own
        // focus guards) and these map to the *file* clipboard, not the text
        // selection, so roles would be wrong here.
        { label: "Copy", click: command("copy") },
        { label: "Cut", click: command("cut") },
        { label: "Paste", click: command("paste") },
        { label: "Select All", click: command("select-all") },
        { type: "separator" },
        // Click-only: the lib binds plain Delete and F2 internally.
        { label: "Delete", click: command("delete") },
        {
          label: "Rename",
          click: command("rename"),
        },
        { type: "separator" },
        // Disabled placeholder for a future settings screen.
        { label: "Preferences...", enabled: false },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Refresh",
          accelerator: accel("refresh"),
          click: command("refresh"),
        },
        { type: "separator" },
        // WebContents-level reload of the whole app (resets all tabs/state),
        // as opposed to the directory "Refresh" above. The lib does not bind
        // Ctrl+R (it only binds Ctrl+F5), so the default accelerators are free.
        // Dev-only: hidden unless ELECTRON_XPLORER_DEVTOOLS=1 is set.
        ...(isDev
          ? [
            { role: "reload" as const, label: "Reload App" },
            { role: "forceReload" as const, label: "Force Reload App" },
            { type: "separator" as const },
            { role: "toggleDevTools" as const },
            { type: "separator" as const },
          ]
          : []),
        {
          label: "Show Hidden Files",
          click: command("show-hidden"),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
      ],
    },
    {
      label: "Go",
      submenu: [
        { label: "Back", accelerator: accel("back"), click: command("back") },
        {
          label: "Forward",
          accelerator: accel("forward"),
          click: command("forward"),
        },
        { label: "Up", accelerator: accel("up"), click: command("up") },
        { label: "Home", accelerator: accel("home"), click: command("home") },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Electron Xplorer",
          click: () => {
            void dialog.showMessageBox({
              type: "info",
              title: "About Electron Xplorer",
              message: "Electron Xplorer",
              detail:
                `A file explorer built with Electron and fs-explorer.\nVersion ${app.getVersion()}`,
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];
  // macOS (and any platform whose convention is an app menu as the first
  // menu) gets Electron's built-in app menu prepended; inert elsewhere.
  if (getMainPlatform().usesAppMenu()) {
    template.unshift({ role: "appMenu" });
  }
  return template;
}

/** Registers all menu handlers. Call once during app startup. */
export function registerMenuHandlers(): void {
  // registerMenuHandlers() is called at module scope (before `ready`); the
  // Menu API is only usable after the app is ready.
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  });
}
