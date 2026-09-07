// What every agent is told about working inside a toyon worktree, and how a chat message becomes
// an ACP prompt. Agents whose adapter takes a system-prompt override get SYSTEM_APPEND through
// it; the others get it prepended to the first prompt of a session.

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ImageRef } from "@toyon/shared";

export const SYSTEM_APPEND = [
  "You are working inside a dedicated git worktree managed by Toyon.",
  "Stay strictly within the current working directory; never modify files outside it.",
  "Never run `git push`, delete branches, or create pull requests — shipping is handled by the Toyon UI.",
  "Never run `git commit` unless the user explicitly asks you to — leave changes uncommitted for the user to review and commit themselves.",
  "Keep the scope tight: do the asked task well, then stop. Suggest follow-ups in chat instead of expanding scope.",
].join(" ");

/** what the model reads as an image's label: its session number (how the user will refer to it
 * later) and where it came from */
export function imageCaption(ref: ImageRef): string {
  return `Image ${ref.n}: ${ref.name} (${ref.width}×${ref.height})`;
}

/** images go first, each behind its caption, then the text; context (live-page state, picked
 * elements) rides after the text. The visible transcript only ever shows the text itself. */
export function buildPrompt(
  text: string,
  context?: string,
  prefix?: string,
  images: Array<{ ref: ImageRef; bytes: Buffer }> = [],
): ContentBlock[] {
  const body = context ? `${text}\n\n${context}` : text;
  const blocks: ContentBlock[] = [];
  for (const { ref, bytes } of images) {
    blocks.push({ type: "text", text: imageCaption(ref) });
    blocks.push({ type: "image", mimeType: ref.mimeType, data: bytes.toString("base64") });
  }
  blocks.push({ type: "text", text: prefix ? `${prefix}\n\n${body}` : body });
  return blocks;
}
