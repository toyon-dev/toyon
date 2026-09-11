// The recap line: what happened while you were away, as when it stopped and the agent's own
// sentence about it. The composer opens on it as its placeholder, and the rail row's tip carries it.

import type { LastTurn, TurnFacts } from "@toyon/shared";
import { ago } from "./util.ts";

/** a clause that ends the line gets its full stop, unless it brought its own */
const ended = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

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

/** The time leads and the sentence follows it, because the sentence already says how it ended:
 * whoever reads this is deciding what to type next, and how long ago is the one fact it cannot
 * tell them. */
export function recapLine(turn: LastTurn): string {
  const age = ago(turn.at);
  const text = turn.recap?.text;
  if (!text) return facts(turn.end, turn.facts, age);
  return `${age === "now" ? "Just now" : `${age} ago`}. ${ended(text)}`;
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
