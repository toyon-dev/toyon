// What every agent is told about working inside a toyon worktree, and how a chat message becomes
// an ACP prompt. Agents whose adapter takes a system-prompt override get SYSTEM_APPEND through
// it; the others get it prepended to the first prompt of a session.

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ImageRef, PasteRef, PickRef, ProcStatus } from "@toyon/shared";
import { attachmentLabel, lineSpan } from "@toyon/shared";
import type { Stored } from "./attachments.ts";

export const SYSTEM_APPEND = [
  "You are working inside a dedicated git worktree managed by Toyon.",
  "Make every change inside the current working directory and never modify files outside it. Reading files outside it is fine when the user points you there.",
  "A write Toyon refuses (outside the worktree, or to an agent's own settings such as .claude/ or opencode.json) was refused by Toyon and not by the user, who was never asked. Report it as the boundary that stopped it, never as the user declining.",
  "Never run `git push`, delete branches, or create pull requests; shipping is handled by the Toyon UI.",
  "Never run `git commit` unless the user explicitly asks you to; leave changes uncommitted for the user to review and commit themselves.",
  "Keep the scope tight: do the asked task well, then stop. Suggest follow-ups in chat instead of expanding scope.",
  "`@some/path` in a message means read that file or directory first; `@changes` means this worktree's uncommitted files, which `git status` lists.",
  'Toyon previews the project in a browser panel by running the commands in its settings file, .toyon/settings.json (or toyon.json at the repo root, in a repo that keeps it there), shaped like {"setup": ["bun install"], "run": {"web": "bun run dev --port $PORT"}, "check": "bun run check", "land": {"route": "merge"}}: setup runs once in every new worktree, every command in run keeps running and must listen on $PORT, which toyon sets differently for each worktree, check (optional) runs after each of your turns and must pass before the work can land, and land (optional) says how the user lands work on main: route "merge" (onto main here), "push" (onto main here, then pushed) or "pr" (a pull request); method "merge", "squash" or "rebase" for how the commits arrive on main; automerge true when GitHub should merge the pull request itself. A settings.local.json beside it (toyon.local.json at the root) holds one person\'s overrides and is never committed.',
  "Toyon runs those commands itself in every worktree, and the user watches the result live in a preview beside this chat, so never start a dev server or open a browser of your own to check your work. Each message says where this worktree's preview answers; fetch a page from there when you want to see it.",
  "When you scaffold a project, write its .gitignore (dependencies, build output, local env files) before installing anything, so an install never leaves thousands of untracked files for the user to wade through or commit.",
  "When you scaffold a project or change how it installs or starts, finish by updating the settings file Toyon already reads, or writing .toyon/settings.json when there is none, so the preview can run it.",
].join(" ");

/** where the project's preview stands as a message goes out, for the block that tells the agent */
export interface PreviewStanding {
  /** the preview proc's status, or "setup" while the worktree is still being made and has no procs */
  status: ProcStatus | "setup";
  /** where the preview proc answers, or will; absent until it has a port */
  url?: string;
  /** the supervisor's diagnosis of a proc that is not answering */
  detail?: string;
}

/** Everything Toyon adds behind a message, wrapped once: what the shell sent with it (the page
 * under the user's eyes, what they ran, a new project's brief) and what the daemon knows as it goes
 * out (where the preview stands, what the tree owes main). One opening, so the agent reads one
 * voice, and the name on it is enough to say the user typed none of it; nothing when there is
 * nothing to say. */
export function ambientBlock(paragraphs: readonly (string | undefined)[]): string | undefined {
  const said = paragraphs.filter((p): p is string => !!p);
  if (said.length === 0) return undefined;
  return `[Attached by Toyon:\n${said.join("\n\n")}]`;
}

/** The paragraph after every message that says where the preview is, so the agent checks its work
 * there instead of starting a server of its own. It goes with each message rather than once at
 * launch: the port lives with the runtime, which a settings change rebuilds under a session that
 * stays up; the first message of a new worktree goes out before setup has given it one; and a proc
 * that ignores $PORT is only found on its real port later. Nothing when there is nothing to run. */
export function previewContext(p: PreviewStanding | null): string | undefined {
  if (!p) return undefined;
  const at = p.url ? ` at ${p.url}` : "";
  let line: string;
  switch (p.status) {
    case "setup":
      line =
        "Toyon is setting this worktree up and starts the preview when that is done; the next message will say where it answers.";
      break;
    case "starting":
      line = `Toyon is starting the preview; it answers${at} once it is up.`;
      break;
    case "running":
      line = `The preview is running${at}, and the user sees it live beside this chat.`;
      break;
    case "asleep":
      line = `The preview is asleep; it answers${at} once the user opens this worktree again.`;
      break;
    default:
      line = `The preview is ${p.status}${p.detail ? `: ${p.detail}` : ""}; nothing answers${at} until it is back.`;
  }
  return line;
}

/** what the model reads as an image's label: its session number (how the user will refer to it
 * later) and where it came from */
export function imageCaption(ref: ImageRef): string {
  return `${attachmentLabel("image", ref.n)}: ${ref.name} (${ref.width}×${ref.height})`;
}

/** the same for a paste: its number, then where it was copied from or, for text with no file
 * behind it, its size and enough of the first line to tell two apart */
export function pasteCaption(ref: PasteRef): string {
  const label = attachmentLabel("paste", ref.n);
  const s = ref.source;
  if (s) {
    const lines = `${s.startLine === s.endLine ? "line" : "lines"} ${lineSpan(s)}`;
    const at = s.ref ? ` at commit ${s.ref.slice(0, 7)}` : "";
    return `${label} (copied from ${lines} of ${s.path}${at})`;
  }
  const from = ref.name ? `${ref.name}, ` : "";
  return `${label} (${from}${ref.lines} lines, ${ref.chars} chars), begins: ${ref.preview}`;
}

/** the same for an element picked in the preview, named the way its chip names it rather than
 * numbered: a component and its file are already a name. Both files, and which is which: the JSX
 * alone sends the agent into the shared component when the line to change is the one that writes it. */
export function pickCaption(ref: PickRef): string {
  const at = (file: string, line: number | null) => `${file}${line ? `:${line}` : ""}`;
  const what = ref.component ? `<${ref.component} />` : `<${ref.tag}>`;
  const where = ref.callFile
    ? ` used at ${at(ref.callFile, ref.callLine)}${ref.file ? `, its own JSX at ${at(ref.file, ref.line)}` : ""}`
    : ref.file
      ? ` defined at ${at(ref.file, ref.line)}`
      : "";
  const text = ref.text ? `, text "${ref.text}"` : "";
  return `An element the user picked in the preview: ${what}${where}${text}\nits HTML: ${ref.html}`;
}

// An agent only dispatches a slash command when it leads the first text block, so a message that
// opens with one goes ahead of the attachments and SYSTEM_APPEND. Ambient context (the preview's
// route, title, console errors) is dropped from such a message: on the command's line it reads as
// arguments, and in a block of its own it still costs the command its dispatch, since an adapter
// recognises some commands only in a prompt that is the command and nothing else (the Claude
// adapter never runs `/usage` when a second block is present).
const LEADING_COMMAND = /^\/[A-Za-z0-9]/;

/** attachments go first, each behind its caption and in the order they were attached, then the
 * text; context (live-page state) rides after it, except on a message that leads with a slash
 * command, which goes alone. A message that is attachments alone has no text block: the paste or
 * the picked element is the whole message. The visible transcript only ever shows the text itself. */
export function buildPrompt(
  text: string,
  context?: string,
  prefix?: string,
  attachments: readonly Stored[] = [],
): ContentBlock[] {
  const leads = LEADING_COMMAND.test(text);
  const blocks: ContentBlock[] = [];
  if (leads) {
    blocks.push(textBlock(text));
    if (prefix) blocks.push(textBlock(prefix));
  }
  for (const a of attachments) blocks.push(...attachmentBlocks(a));
  const body = [prefix, text].filter(Boolean).join("\n\n");
  if (!leads && body) blocks.push(textBlock(body));
  if (context && !leads) blocks.push(textBlock(context));
  return blocks;
}

const textBlock = (text: string): ContentBlock => ({ type: "text", text });

function attachmentBlocks(a: Stored): ContentBlock[] {
  switch (a.kind) {
    case "image":
      return [
        textBlock(imageCaption(a.ref)),
        { type: "image", mimeType: a.ref.mimeType, data: a.bytes.toString("base64") },
      ];
    case "paste":
      return [textBlock(`${pasteCaption(a.ref)}\n<pasted-text ${a.ref.n}>\n${a.text}\n</pasted-text>`)];
    case "pick":
      return [textBlock(pickCaption(a.ref))];
  }
}
