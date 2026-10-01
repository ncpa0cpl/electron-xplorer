import { createElement } from "@ncpa0cpl/vanilla-jsx";
import { sig } from "@ncpa0cpl/vanilla-jsx/signals";
import type { Signal } from "@ncpa0cpl/vanilla-jsx/signals";
import type { PlatformId } from "../shared/platform/types";

/**
 * Custom integrated titlebar replacing the native window title bar
 * (createWindow spreads the platform bridge's `titlebarWindowOptions()`:
 * darwin hides only the native title bar; every other platform is frameless).
 *
 * The whole bar is a `-webkit-app-region: drag` region (window dragging;
 * double-click toggles maximize via an explicit listener, since dblclick on
 * a drag region does not automatically maximize on all platforms) and every
 * interactive child is `no-drag` (via .titlebar-buttons).
 *
 * Platform split:
 *  - darwin: NO custom buttons - the native traffic lights stay at their
 *    default top-left position (titleBarStyle: "hidden"), so the bar only
 *    reserves ~76px of drag space for them (left padding) and shows the
 *    title.
 *  - every other platform: minimize / maximize-or-restore / close buttons on
 *    the RIGHT (native Windows/Linux conventions; close hover = red).
 *
 * The maximize button's glyph reflects the live window state: the initial
 * value comes from the `window:isMaximized` query channel and updates are
 * pushed on the `window:maximizedChanged` channel (see
 * src/main/window-handlers.ts). bootstrap() runs once for the app's
 * lifetime, so a direct subscription without teardown is appropriate here.
 *
 * The label is intentionally static ("Electron Xplorer"): the BrowserWindow's
 * native title already syncs with the active directory (setupWindowTitleSync
 * in src/renderer/actions.ts), and a per-directory label would need extra
 * plumbing for little gain.
 */

/** Left padding reserving space for the native macOS traffic lights. */
const MACOS_TRAFFIC_LIGHTS_PADDING = "76px";

/** Bar height - must match `.titlebar` height in src/index.css. */
export const TITLEBAR_HEIGHT_PX = 38;

export interface TitlebarProps {
  /**
   * The platform id the bootstrap already fetched from main
   * ("system:getPlatformInfo"). Only "darwin" changes the layout.
   */
  platformId: PlatformId;
}

/** Builds the integrated titlebar element (mount it ABOVE the explorer). */
export function Titlebar(props: TitlebarProps): HTMLElement {
  const { platformId } = props;
  const usesNativeControls = platformId === "darwin";

  // Maximized state, kept in sync with the window (initial query + push).
  const maximized = sig(false);
  void window.xplorer.isMaximized().then((value) => {
    maximized.dispatch(value);
  });
  window.xplorer.onMaximizedChanged((value) => {
    maximized.dispatch(value);
  });

  const title = createElement(
    "div",
    { class: "titlebar-title" },
    "File Xplorer",
  );

  const children: HTMLElement[] = usesNativeControls
    // macOS: the native traffic lights are overlaid on the bar's left edge;
    // nothing custom to render, just reserve their space.
    ? [title]
    : [
      title,
      createElement(
        "div",
        { class: "titlebar-buttons" },
        controlButton(
          "titlebar-btn-minimize",
          "Minimize",
          [minimizeGlyph()],
          () => void window.xplorer.minimize(),
        ),
        controlButton(
          "titlebar-btn-maximize",
          "Maximize or restore",
          [maximizedGlyphHost(maximized)],
          () => void window.xplorer.maximizeOrRestore(),
        ),
        controlButton(
          "titlebar-btn-close",
          "Close",
          [closeGlyph()],
          () => void window.xplorer.close(),
        ),
      ),
    ];

  const bar = createElement("div", {
    class: usesNativeControls ? "titlebar titlebar-macos" : "titlebar",
  }) as HTMLElement;
  for (const child of children) {
    bar.appendChild(child);
  }

  // Double-click on the drag region toggles maximize/restore. Clicks on the
  // window-control buttons must not count (a fast maximize/maximize double
  // click would otherwise toggle a third time via the bubbling dblclick).
  bar.addEventListener("dblclick", (ev) => {
    const target = ev.target;
    if (target instanceof Element && target.closest(".titlebar-buttons")) {
      return;
    }
    void window.xplorer.maximizeOrRestore();
  });

  if (usesNativeControls) {
    // Extra safety net around the CSS padding: keep the traffic-light zone
    // clear even if the stylesheet is missing.
    title.style.paddingLeft = MACOS_TRAFFIC_LIGHTS_PADDING;
  }

  return bar;
}

/**
 * Builds a span that always shows the maximize/restore glyph matching the
 * `maximized` signal. The glyph swap is imperative (both SVGs pre-built,
 * swapped via replaceChildren in an `observe()` callback) because
 * createElement's child types don't accept a bare signal element; `observe()`
 * pins the signal so no extra reference needs to be held (same pattern as the
 * window-title sync in src/renderer/actions.ts).
 */
function maximizedGlyphHost(maximized: Signal<boolean>): HTMLElement {
  const host = createElement("span", {}) as HTMLElement;
  const maximizeSvg = maximizeGlyph();
  const restoreSvg = restoreGlyph();
  host.appendChild(maximizeSvg);
  maximized.observe((m) => {
    host.replaceChildren(m ? restoreSvg : maximizeSvg);
  });
  return host;
}

/** Builds a no-drag window-control button with the given SVG glyph(s). */
function controlButton(
  className: string,
  title: string,
  glyph: HTMLElement[],
  onclick: () => void,
): HTMLElement {
  const button = createElement("button", {
    class: `titlebar-btn ${className}`,
    title,
    onclick,
  }) as HTMLElement;
  for (const glyphPart of glyph) {
    button.appendChild(glyphPart);
  }
  return button;
}

// ─── SVG glyphs (10x10 viewBox, Windows-caption style) ───────────────────────
// Built with vanilla-jsx `attribute:`-prefixed SVG props (same pattern the
// fs-explorer lib uses for its SVG icons); stroke styling lives in CSS
// (currentColor, so the close button's white-on-red hover works for free).

function svgGlyph(paths: string[]): HTMLElement {
  const svg = createElement("svg", {
    "attribute:viewBox": "0 0 10 10",
  }) as HTMLElement;
  for (const d of paths) {
    svg.appendChild(createElement("path", { "attribute:d": d }) as HTMLElement);
  }
  return svg;
}

/** Horizontal line. */
function minimizeGlyph(): HTMLElement {
  return svgGlyph(["M0 5H10"]);
}

/** Single square outline. */
function maximizeGlyph(): HTMLElement {
  return svgGlyph(["M0.5 0.5H9.5V9.5H0.5Z"]);
}

/** Front square + partially drawn back square. */
function restoreGlyph(): HTMLElement {
  return svgGlyph(["M0.5 2.5H7.5V9.5H0.5ZM2.5 0.5H9.5V7.5H7.5"]);
}

/** Diagonal cross. */
function closeGlyph(): HTMLElement {
  return svgGlyph(["M0 0L10 10M10 0L0 10"]);
}
