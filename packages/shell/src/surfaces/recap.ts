// The recap line: what happened while you were away, said as facts, then the agent's own sentence
// when one was written. The composer shows it above the box, and the rail row's tip carries it.

import type { LastTurn, TurnFacts } from "@toyon/shared";
import { ago } from "./util.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** a clause that ends the line gets its full stop, unless it brought its own */
const ended = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

function facts(end: LastTurn["end"], f: TurnFacts, age: string): string {
  const when = age === "now" ? "just now" : `${age} ago`;
  const work = [
    f.turns > 1 ? `${f.turns} turns` : null,
    f.edits ? plural(f.edits, "edit") : null,
    f.toolErrors ? plural(f.toolErrors, "failed tool") : null,
  ].filter(Boolean);
  const also = work.length ? `, ${work.join(", ")}` : "";
  switch (end) {
    case "asking":
      return `Waiting on you${age === "now" ? "" : ` for ${age}`}${f.ask ? `: ${ended(f.ask)}` : "."}`;
    case "failed":
      if (f.auth) return `Stopped ${when}: not logged in.`;
      return f.error ? `Failed ${when}: ${ended(f.error)}` : `Failed ${when}${also}.`;
    case "stopped":
      return `Stopped ${when}${also}.`;
    case "done":
      return f.cut ? `Ended early ${when} (${f.cut})${also}.` : `Finished ${when}${also}.`;
  }
}

export function recapLine(turn: LastTurn): string {
  const line = facts(turn.end, turn.facts, ago(turn.at));
  return turn.recap?.text ? `${line} ${turn.recap.text}` : line;
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
