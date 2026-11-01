// Toyon started with npx, offered the global install once it has been used: npx is the right
// first line, one command and nothing left behind, but a copy run from its cache never updates and
// leaves no `toyon` command. The daemon decides whether there is anything to offer (an npx start,
// nothing global on PATH, updates on, not answered before) and runs the install; this says when
// the composer shows it and what the line reads at each step.

import type { GlobalInstall } from "@toyon/shared";
import type { ChatItem } from "../state/store.ts";

/** Whether the composer shows the line now. The offer waits for the first reply to land and the
 * agent to go quiet, like the app install beside it, so it is read once Toyon has done something
 * worth keeping. Once pressed it stays wherever the person is, since the answer belongs there. */
export function globalOfferDue(at: {
  offer: GlobalInstall | null;
  agent: string | undefined;
  chat: readonly ChatItem[];
}): boolean {
  if (!at.offer) return false;
  if (at.offer.state !== "offered") return true;
  return at.agent === "idle" && at.chat.some((i) => i.kind === "assistant");
}

/** npm refusing to write its global folder, which a person fixes once and npm documents */
const PERMISSIONS = /EACCES|EPERM|permission denied/i;
export const PERMISSIONS_GUIDE =
  "https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally";

/** what a failed install says: npm's own last line, the guide when it was a permissions refusal,
 * and the command to run by hand */
export function globalFailedText(f: { line: string; command: string }): {
  why: string;
  permissions: boolean;
  command: string;
} {
  return { why: f.line.replace(/\.$/, ""), permissions: PERMISSIONS.test(f.line), command: f.command };
}
