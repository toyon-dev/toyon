// The flip's card: a worktree's edit touched a shared command's files and Toyon started the
// command here. The chip beside the composer offers the same three places (main's, its own, a
// remote); the card puts them where the moment is, in the chat. Pure, so the sentence and the rows
// are tested as data; FlipCard.tsx draws them.

import type { OwnedWorktree, RepoInfo, TrunkStatus } from "@toyon/shared";
import { remoteIn, type Source, type SourceOption, sourceOptions } from "../chips/sourceChip.ts";
import { procLabel } from "../util.ts";

export type FlipRow = SourceOption & { current: boolean };

export type FlipCardData = {
  /** the word beside the glyph: the command runs here, or did */
  word: "runs here" | "ran here";
  /** what happened and where the command stands now */
  text: string;
  /** where it stands, as the chip reads it; null once the card is history */
  value: Source | null;
  /** the chip's rows, in the chip's order, the current one marked; none for history */
  rows: FlipRow[];
};

type Live = Pick<OwnedWorktree, "worktree" | "borrowed" | "remoteBehind" | "procs">;

/** The card for one command the flip started here, read against the record as it stands now.
 * `file` is the changed file that did it, when the flip knew one. No worktree (archived), or a
 * command the repo no longer shares (dropped from the tier): the card is history, with no rows. */
export function flipCard(
  name: string,
  file: string | undefined,
  wt: Live | null,
  repo: Pick<RepoInfo, "config" | "tier"> | null,
  trunk: Pick<TrunkStatus, "dirty"> | null,
): FlipCardData {
  const why = `this worktree changed ${file ?? "what it runs on"}`;
  if (!wt || !repo || !(name in (repo.tier ?? {}))) {
    return { word: "ran here", text: `${name} ran here: ${why}`, value: null, rows: [] };
  }
  const { value, options } = sourceOptions(name, wt, repo, trunk);
  const rows = options.map((o) => ({ ...o, current: o.id === value }));
  const status = wt.procs?.find((p) => p.name === name)?.status;
  // its own setup runs here ahead of the spawn while the record still says main's: the flip is
  // under way, and the card says so rather than reading the record's word
  const flipping = value === "here" || status === "preparing";
  let text: string;
  if (flipping) {
    // no row yet: own() is about to spawn it, which from the page's side is the same as starting
    const state = status ?? "starting";
    const stands = state === "running" ? `${name} runs here` : `${name} is ${procLabel(state).toLowerCase()} here`;
    const coming = state === "preparing" || state === "starting";
    text = coming ? `${stands}: ${why}; the page reaches main's until it answers` : `${stands}: ${why}`;
  } else if (value === "main") {
    text = `${name} runs on main for every worktree again; it ran here after ${why}`;
  } else {
    text = `${name} points at ${remoteIn(value)} for this worktree; it ran here after ${why}`;
  }
  return { word: flipping ? "runs here" : "ran here", text, value, rows };
}
