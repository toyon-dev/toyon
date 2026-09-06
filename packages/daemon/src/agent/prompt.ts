// What every agent is told about working inside a toyon worktree, and how a chat message becomes
// an ACP prompt. Agents whose adapter takes a system-prompt override get SYSTEM_APPEND through
// it; the others get it prepended to the first prompt of a session.

import type { ContentBlock } from "@agentclientprotocol/sdk";

export const SYSTEM_APPEND = [
  "You are working inside a dedicated git worktree managed by Toyon.",
  "Stay strictly within the current working directory; never modify files outside it.",
  "Never run `git push`, delete branches, or create pull requests — shipping is handled by the Toyon UI.",
  "Never run `git commit` unless the user explicitly asks you to — leave changes uncommitted for the user to review and commit themselves.",
  "Keep the scope tight: do the asked task well, then stop. Suggest follow-ups in chat instead of expanding scope.",
].join(" ");

/** context (live-page state, picked elements) rides after the text; the visible transcript only
 * ever shows the text itself */
export function buildPrompt(text: string, context?: string, prefix?: string): ContentBlock[] {
  const body = context ? `${text}\n\n${context}` : text;
  return [{ type: "text", text: prefix ? `${prefix}\n\n${body}` : body }];
}
