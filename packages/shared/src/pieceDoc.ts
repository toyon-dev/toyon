// A piece of a handoff as one document. The daemon writes it as the plan the piece's worktree is
// born with, and the origin's list page draws it; the same text on both sides, so a person reads
// one plan wherever they open it.

import type { Piece } from "./protocol/events.ts";

/** A text split at its title: the first heading when the text opens with one, so a page can draw
 * a line between the title and the body; null when it opens with prose. */
export function leadHeading(text: string): { title: string | null; rest: string } {
  const m = /^\s*#{1,6}[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(text);
  if (!m) return { title: null, rest: text };
  return { title: m[1]!.trim(), rest: text.slice(m[0].length) };
}

/** the piece's text, titled by its own first heading when it opens with one, else by the piece's
 * title; the title is the rail's word for the worktree either way */
export function pieceDoc(piece: Pick<Piece, "title" | "plan">): string {
  const plan = piece.plan.trim();
  return leadHeading(plan).title === null ? `# ${piece.title}\n\n${plan}\n` : `${plan}\n`;
}
