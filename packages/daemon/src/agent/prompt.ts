// What every agent is told about working inside a toyon worktree, and how a chat message becomes
// an ACP prompt. Agents whose adapter takes a system-prompt override get SYSTEM_APPEND through
// it; the others get it prepended to the first prompt of a session.

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ImageRef, PasteRef } from "@toyon/shared";

export const SYSTEM_APPEND = [
  "You are working inside a dedicated git worktree managed by Toyon.",
  "Stay strictly within the current working directory; never modify files outside it.",
  "Never run `git push`, delete branches, or create pull requests; shipping is handled by the Toyon UI.",
  "Never run `git commit` unless the user explicitly asks you to; leave changes uncommitted for the user to review and commit themselves.",
  "Keep the scope tight: do the asked task well, then stop. Suggest follow-ups in chat instead of expanding scope.",
  "`@some/path` in a message means read that file or directory first; `@changes` means this worktree's uncommitted files, which `git status` lists.",
].join(" ");

/** what the model reads as an image's label: its session number (how the user will refer to it
 * later) and where it came from */
export function imageCaption(ref: ImageRef): string {
  return `Image ${ref.n}: ${ref.name} (${ref.width}×${ref.height})`;
}

/** the same for a paste: its number, its size, and enough of the first line to tell two apart */
export function pasteCaption(ref: PasteRef): string {
  const from = ref.name ? `${ref.name}, ` : "";
  return `Pasted text ${ref.n} (${from}${ref.lines} lines, ${ref.chars} chars), begins: ${ref.preview}`;
}

// An agent only dispatches a slash command when it leads the first text block, so a message that
// opens with one goes ahead of everything the prompt would otherwise start with: image captions,
// and SYSTEM_APPEND on a prompt-prefix agent's first turn.
//
// Ambient context (the live preview's route, title, console errors) is dropped outright on such a
// message. It cannot ride along: concatenated onto the command's line it reads as that command's
// arguments, and in a block of its own it still costs the command its dispatch, because an adapter
// recognises some commands only in a prompt that is the command and nothing else. `/usage` is the
// one that made this visible: with a second block the Claude adapter never runs it, and the model
// answers in prose that /usage is a CLI command it cannot reach. Nobody loses anything real here:
// the context describes what is on screen, and a command was not asking about the screen.
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
