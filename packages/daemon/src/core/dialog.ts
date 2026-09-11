// The OS folder dialog, behind the new-project form's "choose in Finder". It opens on the machine
// the daemon runs on, which is the machine the person is at only for a local macOS daemon; hello's
// `folderDialog` tells the shell whether this is one.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { UserError } from "./errors.ts";

const PROMPT = "Choose a folder for the new project";

// The prompt and the start folder arrive as arguments rather than spliced into the source, so a
// quote in a folder name is data and not script.
const SCRIPT = [
  "on run argv",
  "POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))",
  "end run",
];

/** `(start) => the folder picked, or null when cancelled`. One dialog at a time: a second ask while
 * one is up, from another tab or a second click, waits on the same answer rather than stacking a
 * second modal behind the first. */
export function folderDialog(): (start: string) => Promise<string | null> {
  let open: Promise<string | null> | null = null;
  return (start) => {
    if (process.platform !== "darwin") {
      return Promise.reject(new UserError("choosing a folder in Finder is only available on macOS"));
    }
    if (!open) {
      open = ask(start).finally(() => {
        open = null;
      });
    }
    return open;
  };
}

async function ask(start: string): Promise<string | null> {
  const typed = start === "~" || start.startsWith("~/") ? `${homedir()}${start.slice(1)}` : start;
  // a start folder that is not there makes AppleScript refuse the whole dialog
  const from = typed.startsWith("/") && existsSync(typed) ? typed : homedir();
  const p = Bun.spawn(["osascript", ...SCRIPT.flatMap((line) => ["-e", line]), PROMPT, from], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code === 0) return out.trim().replace(/\/+$/, "") || "/";
  // -128 is the Cancel button: an answer, not a failure
  if (err.includes("(-128)")) return null;
  throw new UserError(`the Finder dialog did not open: ${err.trim()}`);
}
