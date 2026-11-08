// `toyon send`: the composer's send, from a terminal. The daemon reads the current directory and
// does what the shell does for the row it is: a new worktree of the project from its main
// checkout, a take-over of a worktree Toyon does not run, or the chat of one it does. Run by the
// person, or by the agent they are running in that terminal, which runs as them.

import { readFileSync } from "node:fs";
import type { SendReply } from "@toyon/shared";
import { focusShell, openShell } from "./app.ts";
import type { Command } from "./args.ts";
import { ensureDaemon, post } from "./daemon.ts";

/** who is at the keyboard, when the terminal's environment says an agent is: Claude Code marks
 * the shells it runs commands in */
export function sentBy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT ? "Claude Code" : undefined;
}

/** the message: the text given, the file's, or what was piped in */
async function messageOf(cmd: Extract<Command, { kind: "send" }>): Promise<string | null> {
  if (cmd.text !== null) return cmd.text;
  if (cmd.file !== null) return readFileSync(cmd.file, "utf8");
  if (process.stdin.isTTY) return null;
  return await Bun.stdin.text();
}

export async function send(cmd: Extract<Command, { kind: "send" }>): Promise<number> {
  let text: string | null;
  try {
    text = await messageOf(cmd);
  } catch (e) {
    console.error(`toyon: could not read ${cmd.file}: ${(e as Error).message}`);
    return 1;
  }
  if (!text?.trim()) {
    console.error("toyon: give the message as text, with --file, or on stdin");
    return 2;
  }
  const daemon = await ensureDaemon();
  if (!daemon) return 1;
  const by = sentBy();
  const res = await post("/send", daemon.token, {
    path: process.cwd(),
    text,
    ...(by ? { by } : {}),
    ...(cmd.carry ? { carry: true } : {}),
  });
  if (!res.ok) {
    console.error(`could not send: ${await res.text()}`);
    return 1;
  }
  const reply = (await res.json()) as SendReply;
  console.log(sentLine(reply));
  if (reply.delivered) focusShell();
  else openShell(daemon);
  return 0;
}

/** what the terminal reads back: which row took the message, and what stayed on main */
export function sentLine(reply: SendReply): string {
  if (reply.kind === "sent") return `toyon: sent to ${reply.title} in Toyon`;
  const stayed =
    reply.stayed && reply.stayed > 0
      ? `; ${reply.stayed} uncommitted ${reply.stayed === 1 ? "file" : "files"} stayed on main, --carry moves them`
      : "";
  const notice = reply.notice ? `; ${reply.notice}` : "";
  return `toyon: ${reply.title} is open in Toyon${stayed}${notice}`;
}
