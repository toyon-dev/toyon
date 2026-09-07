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
// and SYSTEM_APPEND on a prompt-prefix agent's first turn. Ambient context gets its own block for
// the same reason; concatenated onto `/review` it would read as that command's arguments.
const LEADING_COMMAND = /^\/[A-Za-z0-9]/;

/** attachments go first, each behind its caption, then the text; context (live-page state, picked
 * elements) rides after it. The visible transcript only ever shows the text itself. */
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
  if (context) blocks.push(t(context));
  return blocks;
}
