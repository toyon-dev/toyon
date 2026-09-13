// The recap line: what happened while you were away, as the agent's own sentence about it. The
// composer opens on it as its placeholder, and the rail row's tip carries it.

import type { Landing, LastTurn, PrState, TurnFacts } from "@toyon/shared";
import { ago } from "./util.ts";

/** a clause that ends the line gets its full stop, unless it brought its own */
const ended = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The worktree's PR as the placeholder's first line: what GitHub is waiting on, or that it is
 * done. Read while the PR stands between the work and main. */
export function prLine(pr: PrState): string {
  const n = `PR #${pr.number}`;
  if (pr.state === "merged") return `${n} merged; main here is behind origin.`;
  if (pr.state === "closed") return `${n} was closed without merging.`;
  if (pr.automerge) {
    const on = pr.review === "review_required" ? "it is approved and checks pass" : "checks pass";
    return `${n} open; GitHub merges it when ${on}.`;
  }
  if (pr.mergeable === false) return `${n} open; it conflicts with main.`;
  if (pr.review === "changes_requested") return `${n} open; changes requested.`;
  if (pr.checks === "fail") return `${n} open; checks failed.`;
  if (pr.checks === "pending") return `${n} open; checks running.`;
  if (pr.review === "review_required") return `${n} open; waiting on review.`;
  if (pr.review === "approved") return `${n} approved${pr.checks === "pass" ? ", checks pass" : ""}.`;
  return `${n} open and ready to merge.`;
}

/** GitHub would take the merge now: nothing waiting, nothing failed, nothing conflicting */
export function prCanMerge(pr: PrState): boolean {
  return (
    pr.state === "open" &&
    !pr.automerge &&
    pr.mergeable !== false &&
    pr.review !== "changes_requested" &&
    pr.review !== "review_required" &&
    pr.checks !== "fail" &&
    pr.checks !== "pending"
  );
}

/** The verdict as the placeholder's first line: what would land and whether it can, or what
 * stands in the way. `count` is the files that would go, uncommitted or committed. The model's
 * doubt reads as a caveat on a line that still offers the word, never as a refusal. */
export function landingLine(l: Landing, count: number): string {
  if (l.check === "pending") return "Checking the work…";
  if (l.check === "fail") {
    const first = l.checkTail
      ?.split("\n")
      .find((line) => line.trim())
      ?.trim();
    return `Check failed${first ? `: ${ended(first)}` : "."}`;
  }
  if (l.why) return `Landable, but ${ended(l.why)}`;
  const files = count > 0 ? `${count} ${count === 1 ? "file" : "files"} changed` : "";
  const check = l.check === "pass" ? "check passed" : "";
  const facts = [files, check].filter(Boolean).join(", ");
  return facts ? `Ready to land: ${facts}.` : "Ready to land.";
}

/** How it stopped, for a stop with no sentence to say it: recaps set to facts, a sentence still
 * being written, or none that came back. The counts of turns and edits are not among them; they
 * are on the transcript right above, and in the line they read as noise in front of the reason. */
function facts(end: LastTurn["end"], f: TurnFacts, age: string): string {
  const when = age === "now" ? "just now" : `${age} ago`;
  switch (end) {
    case "asking":
      return `Waiting on you${age === "now" ? "" : ` for ${age}`}${f.ask ? `: ${ended(f.ask)}` : "."}`;
    case "failed":
      if (f.auth) return `Stopped ${when}: not logged in.`;
      return f.error ? `Failed ${when}: ${ended(f.error)}` : `Failed ${when}.`;
    case "stopped":
      return `Stopped ${when}.`;
    case "done":
      return f.cut ? `Ended early ${when} (${f.cut}).` : `Finished ${when}.`;
  }
}

/** The sentence is the whole line when there is one: the rail row beside it carries the time, and
 * how it ended is what the sentence says. Without one, the facts are all there is, and they lead
 * with how long ago because nothing else would say it. */
export function recapLine(turn: LastTurn): string {
  const text = turn.recap?.text;
  return text ? ended(text) : facts(turn.end, turn.facts, ago(turn.at));
}

/** The line is for the stop this tab arrived to, and only while the box is empty and the agent is
 * not running again: once you write, or a turn starts, it has done its job. */
export function recapShown(
  turn: LastTurn | undefined,
  latched: number | undefined,
  blank: boolean,
  running: boolean,
): boolean {
  return !!turn?.recap && latched === turn.at && blank && !running;
}
