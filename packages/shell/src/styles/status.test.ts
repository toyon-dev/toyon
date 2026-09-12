import { describe, expect, test } from "bun:test";
import { cssRules, shellCss } from "./cssRules.ts";

/**
 * The status dress: top anchored, in the reading face, with no card.
 *
 * Top anchored, which is the half that matters: a status grows while it is being read, so anything
 * that centres it vertically pushes the lines already under someone's eye. Its column is centred
 * like every other view's, which is safe because the width is fixed and the horizontal position
 * therefore never moves as content arrives. That distinction was got wrong once in the other
 * direction: pinned to the corner, a one-line status read as a stray log line.
 *
 * The face rule is the other half. Prose here is the shell's own voice explaining a state, so it
 * reads in the UI face; mono is for the machine's literal output, which is one part.
 */

/** the one part that shows what a process or git actually printed */
const EVIDENCE = new Set([".status-tail"]);

/** a status has no ground: a box drawn around a clone's progress is a card around a voice */
const GROUND = ["background", "background-color", "border", "border-radius", "box-shadow"];
const REMOVED = new Set(["none", "transparent", "0", "unset", "initial", "0px"]);

/**
 * Every way a block gets pushed down the region it sits in. `margin-inline: auto` is deliberately
 * not here: centring the column horizontally never moves anything, because the width is fixed.
 */
const SINKING: Record<string, string[]> = {
  "text-align": ["center"],
  "place-items": ["center"],
  "align-items": ["center"],
  "justify-content": ["center"],
  "align-self": ["center"],
};

const isStatus = (sel: string) => /(^|\s|>)\.status(-[\w-]+)?\b/.test(sel);

describe("the status dress", () => {
  test("a status is top anchored, so growing it never moves what is being read", async () => {
    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      for (const sel of rule.selectors) {
        if (!isStatus(sel)) continue;
        for (const [prop, bad] of Object.entries(SINKING)) {
          const v = rule.decls.get(prop);
          if (v && bad.includes(v)) offenders.push(`${sel} sinks itself with ${prop}: ${v}`);
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
