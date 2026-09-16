import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import postcss from "postcss";
import { shellCss } from "./cssRules.ts";

/**
 * The frame is one decision, made in app/phone.ts, and everything else reads it.
 *
 * Two ways that used to drift, and would again. A width query in a stylesheet is a second copy of
 * the breakpoint, kept equal to the first by a test until the phone's root took its own token tier
 * and there was no query left to hold. And a rule under a width query is transparent to cssRules,
 * so it flattens into the same selector as the desk rule it was meant to qualify, and the docks and
 * chat-side tests go on asserting the phone's values while passing. Both go away by having no such
 * query at all: the frame is a branch in the markup, and what differs on a phone is on a class the
 * phone frame alone renders.
 */

const SRC = new URL("..", import.meta.url).pathname;

describe("the frame is one decision", () => {
  test("no stylesheet asks about the width, the hover or the pointer", async () => {
    const offenders: string[] = [];
    postcss.parse(await shellCss()).walkAtRules("media", (at) => {
      if (/width|hover|pointer/.test(at.params)) offenders.push(`@media ${at.params}`);
    });
    expect(offenders).toEqual([]);
  });

  // Reading the window's width is nobody's business but their own: a dock clamps to half of it
  // (clampW) and a float is placed against it. What may not spread is the question app/phone.ts
  // answers: a width weighed against a number, or a query about width or hover, anywhere else is
  // a second breakpoint, and the two drift the moment either moves.
  test("which frame this is, and whether it is touched, get asked in one place", async () => {
    const offenders: string[] = [];
    for (const file of new Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })) {
      if (file.endsWith(".test.ts") || file === "app/phone.ts") continue;
      const code = await Bun.file(`${SRC}${file}`).text();
      if (/\bin(ner)?Width\s*[<>]|[<>]=?\s*window\.innerWidth/.test(code)) {
        offenders.push(`${file}: weighs a width against a number; the frame is app/phone.ts's call`);
      }
      if (/matchMedia\([^)]*(width|hover|pointer)/.test(code)) {
        offenders.push(`${file}: asks the window what app/phone.ts already answered`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});

/**
 * The phone moves around without moving the desk. The reducer holds this for every action (the
 * panels write is the desk's alone), and store.test.ts proves it; this is the second lock, on the
 * frame's own code, so that a control which *only* rearranges a desk nobody is looking at never
 * gets drawn on a phone in the first place.
 */
describe("the phone frame", () => {
  /** every action whose reducer opens or shuts a dock or a pane */
  const WRITES_PANELS = [
    "toggle-changes",
    "focus-changes",
    "edit-commit",
    "toggle-chat",
    "focus-chat",
    "show-chat",
    "open-draft",
    "toggle-terminal",
    "focus-terminal",
    "toggle-design",
  ];

  test("dispatches nothing that opens or shuts a dock or a pane", async () => {
    const offenders: string[] = [];
    for (const file of new Glob("surfaces/phone/**/*.{ts,tsx}").scanSync({ cwd: SRC })) {
      if (file.endsWith(".test.ts")) continue;
      const code = await Bun.file(`${SRC}${file}`).text();
      for (const action of WRITES_PANELS) {
        if (code.includes(`a: "${action}"`)) offenders.push(`${file}: ${action}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
