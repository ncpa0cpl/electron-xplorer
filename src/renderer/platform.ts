import type { Platform } from "../shared/platform/types";

/**
 * Renderer-side platform holder.
 *
 * The renderer never detects the platform itself: during bootstrap
 * (src/renderer/app.ts) it fetches the `PlatformId` from the main process
 * ("system:getPlatformInfo"), builds the shared `Platform` via the
 * renderer-side factory (`createPlatform` - the only platform switch on the
 * renderer side), and stores it here for the rest of the renderer lifetime.
 *
 * Module-level holder rather than per-module factories: actions.ts,
 * drag-out.ts and media-thumbs.ts are plain callback tables wired into
 * fs-explorer; threading a parameter through the lib's callback signatures
 * would require wrapping every one of them. The holder is initialized once,
 * before any action can possibly run (the Explorer is constructed only after
 * `initRendererPlatform`), and is deterministic (never re-set).
 */

let current: Platform | undefined;

/** Stores the platform implementation. Called once during bootstrap. */
export function initRendererPlatform(platform: Platform): void {
  current = platform;
}

/** The renderer's platform implementation. Throws if bootstrap hasn't run. */
export function rendererPlatform(): Platform {
  if (current === undefined) {
    throw new Error("Renderer platform not initialized (bootstrap order bug)");
  }
  return current;
}
