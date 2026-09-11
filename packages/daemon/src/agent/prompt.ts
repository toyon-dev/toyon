// What every agent is told about working inside a toyon worktree, and how a chat message becomes
// an ACP prompt. Agents whose adapter takes a system-prompt override get SYSTEM_APPEND through
// it; the others get it prepended to the first prompt of a session.

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ImageRef, PasteRef } from "@toyon/shared";
import { lineSpan } from "@toyon/shared";

export const SYSTEM_APPEND = [
  "You are working inside a dedicated git worktree managed by Toyon.",
  "Stay strictly within the current working directory; never modify files outside it.",
  "Never run `git push`, delete branches, or create pull requests; shipping is handled by the Toyon UI.",
  "Never run `git commit` unless the user explicitly asks you to; leave changes uncommitted for the user to review and commit themselves.",
  "Keep the scope tight: do the asked task well, then stop. Suggest follow-ups in chat instead of expanding scope.",
  "`@some/path` in a message means read that file or directory first; `@changes` means this worktree's uncommitted files, which `git status` lists.",
  'Toyon previews the project in a browser panel by running the commands in toyon.json at the repo root, shaped like {"procs": {"web": "bun run dev --port $PORT"}, "setup": ["bun install"]}: every proc must listen on $PORT, which toyon sets differently for each worktree, and setup runs once in every new worktree.',
  "When you scaffold a project, write its .gitignore (dependencies, build output, local env files) before installing anything, so an install never leaves thousands of untracked files for the user to wade through or commit.",
  "When you scaffold a project or change how it installs or starts, finish by writing or updating toyon.json so the preview can run it.",
].join(" ");

/** what the model reads as an image's label: its session number (how the user will refer to it
 * later) and where it came from */
export function imageCaption(ref: ImageRef): string {
  return `Image ${ref.n}: ${ref.name} (${ref.width}×${ref.height})`;
}

/** the same for a paste: its number, then where it was copied from or, for text with no file
 * behind it, its size and enough of the first line to tell two apart */
export function pasteCaption(ref: PasteRef): string {
  const s = ref.source;
  if (s) {
    const lines = `${s.startLine === s.endLine ? "line" : "lines"} ${lineSpan(s)}`;
    const at = s.ref ? ` at commit ${s.ref.slice(0, 7)}` : "";
    return `Pasted text ${ref.n} (copied from ${lines} of ${s.path}${at})`;
  }
  const from = ref.name ? `${ref.name}, ` : "";
  return `Pasted text ${ref.n} (${from}${ref.lines} lines, ${ref.chars} chars), begins: ${ref.preview}`;
}

// An agent only dispatches a slash command when it leads the first text block, so a message that
// opens with one goes ahead of image captions and SYSTEM_APPEND. Ambient context (the preview's
// route, title, console errors) is dropped from such a message: on the command's line it reads as
// arguments, and in a block of its own it still costs the command its dispatch, since an adapter
// recognises some commands only in a prompt that is the command and nothing else (the Claude
// adapter never runs `/usage` when a second block is present).
const LEADING_COMMAND = /^\/[A-Za-z0-9]/;

/** attachments go first, each behind its caption, then the text; context (live-page state, picked
 * elements) rides after it, except on a message that leads with a slash command, which goes alone.
 * The visible transcript only ever shows the text itself. */
export function buildPrompt(
  text: string,
  context?: string,
  prefix?: string,
  images: Array<{ ref: ImageRef; bytes: Buffer }> = [],
  pastes: Array<{ ref: PasteRef; text: string }> = [],
): ContentBlock[] {
  const t = (s: string): ContentBlock => ({ type: "text", text: s });
  const leads = LEADING_COMMAND.test(text);
  const blocks: ContentBlock[] = [];
  if (leads) {
    blocks.push(t(text));
    if (prefix) blocks.push(t(prefix));
  }
  for (const { ref, bytes } of images) {
    blocks.push(t(imageCaption(ref)));
    blocks.push({ type: "image", mimeType: ref.mimeType, data: bytes.toString("base64") });
  }
  for (const p of pastes) blocks.push(t(`${pasteCaption(p.ref)}\n<pasted-text ${p.ref.n}>\n${p.text}\n</pasted-text>`));
  if (!leads) blocks.push(t(prefix ? `${prefix}\n\n${text}` : text));
  if (context && !leads) blocks.push(t(context));
  return blocks;
}
