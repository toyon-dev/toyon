// The recap line: what happened while you were away, as the agent's own sentence about it. The
// composer opens on it as its placeholder, and the rail row's tip carries it.

import type { Landing, LastTurn, TurnFacts } from "@toyon/shared";
import { ago } from "./util.ts";

/** a clause that ends the line gets its full stop, unless it brought its own */
const ended = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The verdict as the placeholder's first line: what would land and whether it can, or what
 * stands in the way. `count` is the files that would go, uncommitted or committed. */
export function landingLine(l: Landing, count: number): string {
  if (l.check === "fail") {
    const first = l.checkTail
      ?.split("\n")
      .find((line) => line.trim())
      ?.trim();
    return `Check failed${first ? `: ${ended(first)}` : "."}`;
  }
  if (!l.ready) return l.why ? `Not ready to land: ${ended(l.why)}` : "Not ready to land.";
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
