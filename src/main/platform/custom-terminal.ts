import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * Custom terminal override via the `XPLORER_TERMINAL` environment variable.
 *
 * When `XPLORER_TERMINAL` is set (and non-empty), it overrides ALL built-in
 * terminal detection on every platform (Linux `$TERMINAL` + emulator probing,
 * macOS iTerm/Terminal, Windows wt/powershell/cmd priority). The value is a
 * full COMMAND LINE TEMPLATE run through the system shell - unlike the
 * Linux `$TERMINAL` variable, which names a single bare binary that is
 * spawned directly without a shell.
 */

/** The environment variable holding the custom terminal command line. */
export const CUSTOM_TERMINAL_ENV_VAR = "XPLORER_TERMINAL";

/**
 * POSIX shell single-quoting: wrap in `'…'` and splice `'\''` for each
 * embedded quote (closes the literal, adds an escaped quote, reopens it).
 */
export function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Windows cmd.exe double-quoting: wrap in `"…"`, doubling embedded quotes
 * (the C-runtime argument-parsing convention). Real paths never contain
 * quotes; the doubling only keeps a pathological name from breaking out of
 * the argument.
 */
export function win32ShellQuote(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

/**
 * Expands a command line template for the given (already shell-quoted)
 * directory: every `{dir}` occurrence is replaced, or - when the template
 * has no placeholder - the quoted directory is appended as the final
 * argument. Pure; exported for the platform self-test suite.
 */
export function buildCustomTerminalCommand(
  template: string,
  quotedDir: string,
): string {
  if (template.includes("{dir}")) {
    return template.replaceAll("{dir}", quotedDir);
  }
  return `${template} ${quotedDir}`;
}

/**
 * Returns a promise that launches the user's custom terminal in `dir`, or
 * `null` when `XPLORER_TERMINAL` is unset/empty (the caller then falls back
 * to its platform detection). `shellQuote` quotes the directory for the
 * host shell - each platform module passes its own quoter, keeping the
 * one-switch rule (no `process.platform` branching here).
 *
 * The command string is spawned with `shell: true` (detached, fire-and-
 * forget; `stdio` ignored). The promise resolves as soon as the spawn call
 * itself succeeded - a later failure (mistyped command name) surfaces only
 * in the spawned shell, matching terminal-launcher norms. A short-lived
 * `error` listener still rejects the promise when the spawn fails
 * immediately (synchronous throw or an error emitted before resolution).
 */
export function tryCustomTerminal(
  dir: string,
  shellQuote: (value: string) => string,
): Promise<void> | null {
  const template = process.env[CUSTOM_TERMINAL_ENV_VAR]?.trim() ?? "";
  if (!template) {
    return null;
  }

  const command = buildCustomTerminalCommand(template, shellQuote(dir));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      const message = err instanceof Error ? err.message : String(err);
      reject(
        new Error(
          `Failed to launch the custom terminal (${CUSTOM_TERMINAL_ENV_VAR}`
            + `="${template}"): ${message}`,
        ),
      );
    };

    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd: dir,
        detached: true,
        stdio: "ignore",
      });
    } catch (err) {
      fail(err);
      return;
    }

    child.once("error", fail);
    child.unref();

    // Resolve right after the event loop turns (an immediately-emitted
    // spawn error fires on nextTick, i.e. before this, and wins).
    setImmediate(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}
