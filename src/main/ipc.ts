import { ipcMain } from "electron";
import { getMainPlatform } from "./platform";

/**
 * Small typed wrapper around `ipcMain.handle`.
 *
 * Every handler declares an argument spec; the helper validates each incoming
 * argument before invoking the handler:
 *  - `"path"` arguments must be non-empty strings naming an absolute path on
 *    the running platform (handlers may only ever touch paths the renderer
 *    explicitly passed, so we sanity-check that they are absolute; the
 *    absolute-path rule itself comes from the main platform bridge, so drive
 *    letters and UNC paths validate correctly on Windows and POSIX paths on
 *    linux/macOS),
 *  - argument counts must match the spec exactly.
 */

export type ArgSpec = readonly [];
export type PathArgSpec = readonly ["path"];
export type TwoPathArgSpec = readonly ["path", "path"];

export function handle(
  channel: string,
  spec: readonly [],
  fn: () => unknown,
): void;
export function handle(
  channel: string,
  spec: readonly ["path"],
  fn: (p: string) => unknown,
): void;
export function handle(
  channel: string,
  spec: readonly ["path", "path"],
  fn: (a: string, b: string) => unknown,
): void;
export function handle(
  channel: string,
  spec: readonly string[],
  fn: (...args: never[]) => unknown,
): void {
  ipcMain.handle(channel, (_event, ...args: unknown[]) => {
    if (args.length !== spec.length) {
      throw new Error(
        `IPC ${channel}: expected ${spec.length} argument(s), got ${args.length}`,
      );
    }

    const validated = args.map((arg, i) => {
      const kind = spec[i] as string | undefined;
      switch (kind) {
        case "path":
          return validatePath(channel, i, arg);
        default:
          throw new Error(`IPC ${channel}: unknown argument spec "${kind}"`);
      }
    });

    return (fn as (...args: unknown[]) => unknown)(...validated);
  });
}

function validatePath(channel: string, index: number, arg: unknown): string {
  if (typeof arg !== "string" || arg.length === 0) {
    throw new Error(
      `IPC ${channel}: argument #${index} must be a non-empty string path`,
    );
  }
  if (arg.includes("\0")) {
    throw new Error(`IPC ${channel}: argument #${index} contains a null byte`);
  }
  if (!getMainPlatform().isValidAbsolutePath(arg)) {
    throw new Error(
      `IPC ${channel}: argument #${index} must be an absolute path, got "${arg}"`,
    );
  }
  return arg;
}
