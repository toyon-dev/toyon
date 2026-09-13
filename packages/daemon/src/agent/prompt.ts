// What every agent is told about working inside a toyon worktree, and how a chat message becomes
// an ACP prompt. Agents whose adapter takes a system-prompt override get SYSTEM_APPEND through
// it; the others get it prepended to the first prompt of a session.

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ImageRef, PasteRef, PickRef } from "@toyon/shared";
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
  'Toyon previews the project in a browser panel by running the commands in its settings file, .toyon/settings.json (or toyon.json at the repo root, in a repo that keeps it there), shaped like {"setup": ["bun install"], "run": {"web": "bun run dev --port $PORT"}, "check": "bun run check", "land": {"route": "merge"}}: setup runs once in every new worktree, every command in run keeps running and must listen on $PORT, which toyon sets differently for each worktree, check (optional) runs after each of your turns and must pass before the work can be merged, and land.route (optional: "merge", "push" or "pr") says how the user lands work on main. A settings.local.json beside it (toyon.local.json at the root) holds one person\'s overrides and is never committed.',
  "When you scaffold a project, write its .gitignore (dependencies, build output, local env files) before installing anything, so an install never leaves thousands of untracked files for the user to wade through or commit.",
  "When you scaffold a project or change how it installs or starts, finish by updating the settings file Toyon already reads, or writing .toyon/settings.json when there is none, so the preview can run it.",
].join(" ");

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
 * command, which goes alone. The visible transcript only ever shows the text itself. */
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
  if (!leads) blocks.push(textBlock(prefix ? `${prefix}\n\n${text}` : text));
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
