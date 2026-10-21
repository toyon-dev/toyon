// The OS folder dialog, behind the new-project page's folder controls, and the OS file dialog
// behind the project picker's file button. Either opens on the machine the daemon runs on, which is
// the machine the person is at only for a local macOS daemon; hello's `folderDialog` tells the
// shell whether this is one.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Subprocess } from "bun";
import { UserError } from "./errors.ts";

/** the dialog's own line, by what the page asked it for, and whether it picks a file or a folder */
const PROMPTS = {
  location: { prompt: "Choose where the new project goes", pick: "folder" },
  open: { prompt: "Choose a project folder to open", pick: "folder" },
  file: { prompt: "Choose a file to open", pick: "file" },
} as const;

export type FolderPurpose = keyof typeof PROMPTS;

// The prompt and the start folder arrive as arguments rather than spliced into the source, so a
// quote in a folder name is data and not script. osascript is a background process: without
// `activate` its dialog opens in front but without the keyboard, and an Escape meant for the dialog
// reaches the browser behind it instead.
const script = (pick: "folder" | "file") => [
  "on run argv",
  "activate",
  `POSIX path of (choose ${pick} with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))`,
  "end run",
];

export interface FolderDialog {
  /** the folder (or, for `file`, the file) picked, or null when cancelled */
  choose(start: string, purpose: FolderPurpose): Promise<string | null>;
  /** close the dialog if one is up; the `choose` waiting on it answers null */
  cancel(): void;
}

/** One dialog at a time: a second ask while one is up, from another tab or a second click, waits on
 * the same answer rather than stacking a second modal behind the first. */
export function folderDialog(): FolderDialog {
  let open: Promise<string | null> | null = null;
  let child: Subprocess | null = null;
  let cancelled = false;

  const ask = async (start: string, purpose: FolderPurpose): Promise<string | null> => {
    const typed = start === "~" || start.startsWith("~/") ? `${homedir()}${start.slice(1)}` : start;
    // a start folder that is not there makes AppleScript refuse the whole dialog
    const from = typed.startsWith("/") && existsSync(typed) ? typed : homedir();
    cancelled = false;
    const { prompt, pick } = PROMPTS[purpose];
    const p = Bun.spawn(["osascript", ...script(pick).flatMap((line) => ["-e", line]), prompt, from], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    child = p;
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    child = null;
    if (code === 0) return out.trim().replace(/\/+$/, "") || "/";
    // -128 is the Cancel button, and a dialog killed from the shell was cancelled there: answers, not failures
    if (cancelled || err.includes("(-128)")) return null;
    throw new UserError(`the Finder dialog did not open: ${err.trim()}`);
  };

  return {
    choose(start, purpose) {
      if (process.platform !== "darwin") {
        return Promise.reject(
          new UserError(`choosing a ${PROMPTS[purpose].pick} in Finder is only available on macOS`),
        );
      }
      if (!open) {
        open = ask(start, purpose).finally(() => {
          open = null;
        });
      }
      return open;
    },
    cancel() {
      if (!child) return;
      cancelled = true;
      // the dialog is osascript's own window, so it goes with the process
      child.kill();
    },
  };
}
