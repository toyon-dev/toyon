import { describe, expect, test } from "bun:test";
import { cssRules, shellCss } from "./cssRules.ts";

/**
 * The status dress: the machine speaks from the left, in the reading face, with no card.
 *
 * A form is centred and a status is not, and that is the fastest way to see which one is talking.
 * It also matters mechanically: a status block grows while it is being read (procs arrive, git
 * prints another line), and a centred block that grows moves the lines already under someone's
 * eye. Centring crept back in twice before this was a rule, both times because the sentence being
 * shown that day happened to be one line long.
 *
 * The face rule is the other half. Prose here is the shell's own voice explaining a state, so it
 * reads in the UI face; mono is for the machine's literal output, which is one part.
 */

/** the one part that shows what a process or git actually printed */
const EVIDENCE = new Set([".status-tail"]);

/** a status has no ground: a box drawn around a clone's progress is a card around a voice */
const GROUND = ["background", "background-color", "border", "border-radius", "box-shadow"];
const REMOVED = new Set(["none", "transparent", "0", "unset", "initial", "0px"]);

/** every way a block gets centred, which is the thing a status must never be */
const CENTRING: Record<string, string[]> = {
  "text-align": ["center"],
  "margin-inline": ["auto"],
  margin: ["0 auto", "auto"],
  "place-items": ["center"],
  "justify-content": ["center"],
};

const isStatus = (sel: string) => /(^|\s|>)\.status(-[\w-]+)?\b/.test(sel);

describe("the status dress", () => {
  test("the machine speaks from the left", async () => {
    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      for (const sel of rule.selectors) {
        if (!isStatus(sel)) continue;
        for (const [prop, bad] of Object.entries(CENTRING)) {
          const v = rule.decls.get(prop);
          if (v && bad.includes(v)) offenders.push(`${sel} centres itself with ${prop}: ${v}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  test("prose in the reading face, mono only for what the machine printed", async () => {
    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      const font = rule.decls.get("font") ?? rule.decls.get("font-family") ?? "";
      if (!font.includes("mono")) continue;
      for (const sel of rule.selectors) {
        if (!isStatus(sel) || EVIDENCE.has(sel)) continue;
        offenders.push(`${sel} reads in mono, but only the machine's own output does`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  test("a status draws no ground", async () => {
    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      for (const sel of rule.selectors) {
        if (!isStatus(sel)) continue;
        for (const p of GROUND) {
          const v = rule.decls.get(p);
          if (v && !REMOVED.has(v)) offenders.push(`${sel} draws ${p}: ${v}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
