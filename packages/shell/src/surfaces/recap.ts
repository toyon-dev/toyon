// The recap line: where the work stands, as the agent's own sentence about it. The composer opens
// on it as its placeholder, and the rail row's tip carries it.

import type { Landing, LastTurn, PrState, TurnFacts } from "@toyon/shared";
import { ago } from "./util.ts";

/** a clause that ends the line gets its full stop, unless it brought its own */
const ended = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The worktree's PR as the placeholder's first line: what GitHub is waiting on, or that it is
 * done. Read while the PR stands between the work and main. */
export function prLine(pr: PrState): string {
  const n = `PR #${pr.number}`;
  if (pr.state === "merged") return `${n} merged.`;
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

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** What stands between the work and landing, as the placeholder's first line: the check running,
 * or the check failed. Null once the work can land, when the line is the verb and the recap. */
export function landingLine(l: Landing): string | null {
  if (l.check === "pending") return "Checking the work…";
  if (l.check === "fail") {
    const first = l.checkTail
      ?.split("\n")
      .find((line) => line.trim())
      ?.trim();
    return `Check failed${first ? `: ${ended(first)}` : "."}`;
  }
  return null;
}

/** What would land, for the verb's tooltip: `count` is the files that would go, uncommitted or
 * committed. Empty when there is nothing to count and no check ran. */
export function landFacts(l: Landing, count: number): string {
  const facts = factsOf(l, count);
  return facts ? ended(capital(facts)) : "";
}

/** the facts as a clause, no capital and no stop, so a label can lead them */
function factsOf(l: Landing, count: number): string {
  const files = count > 0 ? `${count} ${count === 1 ? "file" : "files"} changed` : "";
  const check = l.check === "pass" ? "check passed" : "";
  return [files, check].filter(Boolean).join(", ");
}

/** a clause after a label: the model's opening capital comes down when the first word is a plain
 * one; a name (ChatLog.tsx, API) keeps its case */
const clause = (text: string) =>
  /^[A-Z][a-z]+(\s|$)/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;

/** How far the branch trails main, for the land verb's tooltip: the count is decided at the
 * press, since land takes main in before anything else, so it is said there and not on a row of
 * its own under the box, which would leave as the land ran and move the verb from under the
 * cursor. Empty when the branch is level. */
export function behindFact(defaultBranch: string, behind: number | undefined): string {
  const n = behind ?? 0;
  return n > 0 ? `${n} behind ${defaultBranch}; land takes it in first.` : "";
}

/** What is here to check, when no sentence and no message says it: the count alone */
export function filesLine(count: number): string {
  return count > 0 ? ended(capital(`${count} ${count === 1 ? "file" : "files"} changed`)) : "";
}

/** Under the verb's line, the verdict behind a fixed label, so the eye gets the answer before the
 * sentence: rewritten after every turn, the line is scanned far more often than it is read. What
 * is left when the model did not read the work as done; else ready, with the facts. A tree that
 * moved since the verdict was written says so instead, which is why the word above is `check` and
 * not `land`. Never a refusal: the word stays. */
export function verdictLine(l: Landing, count: number): string | null {
  if (l.stale) return "Changed since this was written.";
  if (l.why) return `Not ready: ${ended(clause(l.why))}`;
  const facts = factsOf(l, count);
  return facts ? `Ready: ${facts}.` : "Ready.";
}

/** what the verb's line says after the word, as a whole sentence */
export function verbLine(text: string): string {
  return ended(text);
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
      // the agent ends its turn on a plan sent back and waits for the notes; this line is the
      // composer's placeholder, so it says what to type
      return f.planBack ? `Sent the plan back ${when}. Say what to change.` : `Stopped ${when}.`;
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
