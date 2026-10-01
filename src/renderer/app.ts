import { Explorer, Immediate, Path } from "@ncpa0cpl/fs-explorer";
import type { PlaceInfo } from "../shared/fs-types";
import { createPlatform } from "../shared/platform/types";
import {
  explorerActions,
  fileActions,
  fileDropHandler,
  openAction,
  registerExplorer,
} from "./actions";
import { nativeDragOutHandler } from "./drag-out";
import { createFilesystem } from "./fs-adapter";
import { initRendererPlatform } from "./platform";
import { Titlebar } from "./titlebar";

const dndApi = window.xplorer;

/**
 * Application bootstrap: wires the fs-explorer `Explorer` to the IPC-backed
 * `Filesystem` adapter and mounts it into the document.
 */
export async function bootstrap(): Promise<void> {
  try {
    // Platform identity comes from the main process (never detected here);
    // the shared `createPlatform` switch is the renderer's only platform
    // conditional. Everything downstream (fs adapter, actions, drag-out,
    // thumbnails) reads the platform via the holder/factory below.
    const [homeDir, staticPlaces, platformId] = await Promise.all([
      window.xplorer.getHomeDir(),
      window.xplorer.getStaticPlaces(),
      window.xplorer.getPlatformInfo(),
    ]);
    const platform = createPlatform(platformId);
    initRendererPlatform(platform);

    const filesystem = createFilesystem(platform);

    const [launchFolder, ...extraLaunchFolders] = await window.xplorer
      .takeLaunchFolders();

    // No `await` from here until `onOpenFolders` below: folder requests that
    // arrive in between would be dropped.

    // The Trash is a purely virtual place: the `trash:///` root is served by
    // the renderer fs adapter (fs:listTrash IPC), not by a real directory.
    const trashPlace: PlaceInfo = {
      id: "trash",
      label: "Trash",
      path: "trash:///",
    };

    const explorer = new Explorer(filesystem, {
      initDir: launchFolder ?? homeDir,
      staticPlaces: [...staticPlaces, trashPlace],
      // Double-click on a file opens it with the OS default application
      // (directories are handled by the lib itself: they navigate).
      openAction,
      // Context-menu extras: "Open in Terminal", "Delete Permanently".
      actions: fileActions,
      // Toolbar menu extras: "Open Terminal Here".
      explorerActions,
      // OS drag-in: copies files dropped from a system file manager into the
      // target directory via the `fs:copy` channel.
      fileDropHandler,
      // OS drag-out: hands an in-progress emulated drag to the OS when the
      // pointer leaves the window (see drag-out.ts for the hybrid model).
      nativeDragOut: nativeDragOutHandler,
    });

    for (const folder of extraLaunchFolders) {
      explorer.newTab(folder);
    }
    window.xplorer.onOpenFolders((folders) => {
      for (const folder of folders) {
        explorer.newTab(folder);
      }
    });

    registerExplorer(explorer);

    // Native application menu: map menu commands onto the explorer's public
    // API (see src/main/menu-handlers.ts for the command list).
    setupMenuCommands(explorer, homeDir);

    document.body.classList.add("dark-theme");

    // Layout shell: the integrated titlebar sits ABOVE the explorer in a
    // flex column (see .app-shell/.explorer-host in src/index.css). The
    // explorer element keeps its own internal scrolling - it is sized by the
    // host (flex: 1, min-height: 0) and its stylesheet's height: 100% fills
    // exactly that, so nothing needs to change in the lib's CSS.
    const shell = document.createElement("div");
    shell.className = "app-shell";

    shell.appendChild(Titlebar({ platformId }));

    const explorerHost = document.createElement("div");
    explorerHost.className = "explorer-host";
    explorerHost.appendChild(explorer.element());

    shell.appendChild(explorerHost);
    document.body.appendChild(shell);
  } catch (err) {
    // Startup must not fail silently: log loudly and surface the error in the
    // window so failed IPC/bridge wiring is visible in screenshots too.
    console.error("Failed to initialize the explorer:", err);
    showFatalError(err);
  }
}

function showFatalError(err: unknown): void {
  document.body.classList.add("dark-theme");
  const pre = document.createElement("pre");
  pre.textContent = `Failed to initialize the explorer:\n${
    err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)
  }`;
  pre.style.cssText = "color:#f66;padding:16px;white-space:pre-wrap;";
  document.body.appendChild(pre);
}

// ─── Native menu command mapping ─────────────────────────────────────────────

/**
 * True while a text-entry control has focus, mirroring (a conservative subset
 * of) fs-explorer's internal focus guard: file clipboard/delete/rename menu
 * commands must not fire while the user is typing into an input (e.g. during
 * a rename prompt). Unlike the lib's window-scoped keydown handlers this can
 * check the DOM directly, since menu commands arrive without a key event.
 */
function isTextEditing(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLElement
    && (el.tagName === "INPUT"
      || el.tagName === "TEXTAREA"
      || el.isContentEditable)
  );
}

/**
 * Maps native menu commands onto fs-explorer's public Explorer API.
 *
 * NOTE on typing: fs-explorer's shipped d.ts degrades its vanilla-jsx
 * signal-typed fields to `any` (the "@ncpa0cpl/vanilla-jsx/signals" type
 * references do not resolve from the linked package - see the note in
 * actions.ts), so the `explorer.currentTab/history/location/directory`
 * signal chains used below read as `any`. All of them are public,
 * modifier-less class fields on Explorer/TabController/DirViewController,
 * and several (directory, history) are used exactly this way by the lib's
 * own components (context menu, location bar, left pane).
 */
function setupMenuCommands(explorer: Explorer, homeDir: string): void {
  const activeHistory = () => explorer.history.get();

  window.xplorer.onMenuCommand((command) => {
    switch (command) {
      case "new-tab": {
        // Mirror the lib's own "+" button: open the new tab at the active
        // tab's current location.
        explorer.newTab(explorer.location.get().path);
        break;
      }
      case "close-tab": {
        // Never leave zero tabs: ignore the command on the last one.
        const tabs = explorer.tabs.get();
        if (tabs.length > 1) {
          explorer.closeTab(explorer.activeTab.get());
        }
        break;
      }
      case "refresh": {
        explorer.refresh();
        break;
      }
      case "back": {
        const history = activeHistory();
        if (history.canGoBack()) {
          history.back();
        }
        break;
      }
      case "forward": {
        // `forward()` is a no-op when there is no forward entry.
        activeHistory().forward();
        break;
      }
      case "up": {
        // The lib's location bar "up" is `history.backPush()` (navigates to
        // the parent directory). Skip at the filesystem root, where the
        // parent equals the current path.
        const current = explorer.location.get().path;
        const parent = Path.from(current).dir();
        if (!parent.equals(current)) {
          activeHistory().backPush();
        }
        break;
      }
      case "home": {
        explorer.open(homeDir);
        break;
      }
      case "copy":
      case "cut": {
        if (isTextEditing()) {
          break;
        }
        // Same lookup the lib's own Ctrl+C/X handler performs.
        const files = explorer.directory.get().getActionableFiles();
        if (files) {
          explorer.clipboard.put(files, command === "copy" ? "copy" : "move");
        }
        break;
      }
      case "paste": {
        if (isTextEditing()) {
          break;
        }
        // Same lookup the lib's own Ctrl+V handler performs.
        const dstat = explorer.directory.get().stat.get();
        if (dstat && dstat.write) {
          explorer.fs.clipboardPaste(dstat.path);
        }
        break;
      }
      case "select-all": {
        explorer.directory.get().selectAll();
        break;
      }
      case "delete": {
        if (isTextEditing()) {
          break;
        }
        // Mirror the lib's own plain-Delete handler: trash the actionable
        // files (Filesystem.remove maps to the OS trash), then refresh.

        const files = explorer.directory
          .get()
          .getActionableFiles();
        if (files) {
          Immediate.all(...files.map((f) => explorer.fs.remove(f))).then(() =>
            explorer.refresh()
          );
        }
        break;
      }
      case "rename": {
        if (isTextEditing()) {
          break;
        }
        // Mirror the lib's F2 handler for a single file. The lib's
        // multi-selection bulk-rename overlay is not part of its public
        // exports, so the menu item intentionally does nothing there.
        const files = explorer.directory.get().getActionableFiles();
        if (files && files.length === 1) {
          const file = files[0];
          explorer.prompt
            .input({
              title: "Rename",
              message: "Enter new name:",
              initialValue: file.name,
              placeholder: "Filename",
              // Public method on the public `contextMenu` controller.
              validate: explorer.contextMenu.nameValidator(file.name),
            })
            .then((name) => {
              if (!name) return;
              const newPath = Path.from(file.path).dir().joinSegment(name);
              explorer.fs.move(file, newPath);
            });
        }
        break;
      }
      case "show-hidden": {
        // Public toggle on the active tab's DirViewController (same method
        // the lib's left-pane "Show hidden files" switch calls). Per-tab:
        // each tab tracks its own visibility flag.
        explorer.directory.get().showHiddenFilesToggle();
        break;
      }
      default: {
        // Unknown command (e.g. from a newer main process): ignore silently.
        break;
      }
    }
  });
}
