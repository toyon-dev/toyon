import { describe, expect, test } from "bun:test";
import { cssRules, shellCss } from "./cssRules.ts";

/**
 * One column for every view of toyon's own, declared in one place.
 *
 * The centre once had two columns that were the same column with two numbers changed, a form's and
 * a status's, each with a container and a test of its own. A rule anywhere else that sets a view's
 * margins, measure or anchor is a second column, and two columns drift apart by whichever one
 * someone edits. So those numbers are read by the column's three rules and nowhere else. The gap is
 * not on the list: a part may keep the column's rhythm, as the form's knobs row does.
 *
 * The column is anchored to the top and draws no ground; view.css says why for both.
 */

const COLUMN = new Set([".view", ".view-anchored", ".view-wide"]);
const OWNED = /var\(--view-(inset|top|anchor|measure|measure-wide)\)/;

/** every way a column gets pushed down the region it sits in, which a view that grows must never be */
const SINKING: Record<string, string[]> = {
  "justify-content": ["center"],
  "align-content": ["center"],
  "place-content": ["center"],
  "place-items": ["center"],
  "margin-top": ["auto"],
  "margin-block": ["auto"],
  margin: ["auto"],
};

const GROUND = [
  "background",
  "background-color",
  "border",
  "border-top",
  "border-bottom",
  "border-radius",
  "box-shadow",
];
/** taking a ground away is allowed; painting one is the drift */
const REMOVED = new Set(["none", "transparent", "0", "unset", "initial", "0px"]);

const isView = (sel: string) => /(^|\s|>)\.view(-[\w-]+)?\b/.test(sel);

describe("the view column", () => {
  test("its margins, measure and anchor are read by the column alone", async () => {
    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      for (const [prop, value] of rule.decls) {
        // a token defined in terms of another is the definition, not a second reader
        if (prop.startsWith("--") || !OWNED.test(value)) continue;
        for (const sel of rule.selectors) {
          if (!COLUMN.has(sel)) offenders.push(`${sel} reads ${value} in ${prop}, but the column is .view's`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  test("each measure is declared once", async () => {
    const narrow: string[] = [];
    const wide: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      const width = rule.decls.get("width") ?? "";
      if (width.includes("var(--view-measure)")) narrow.push(...rule.selectors);
      if (width.includes("var(--view-measure-wide)")) wide.push(...rule.selectors);
    }
    expect({ narrow, wide }).toEqual({ narrow: [".view"], wide: [".view-wide"] });
  });

  test("a view is anchored to the top, so growing it never moves what is being read", async () => {
    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      for (const sel of rule.selectors) {
        if (!COLUMN.has(sel)) continue;
        for (const [prop, bad] of Object.entries(SINKING)) {
          const v = rule.decls.get(prop);
          if (v && bad.includes(v)) offenders.push(`${sel} sinks the column with ${prop}: ${v}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  test("a view draws no ground", async () => {
    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      for (const sel of rule.selectors) {
        if (!isView(sel)) continue;
        for (const p of GROUND) {
          const v = rule.decls.get(p);
          if (v && !REMOVED.has(v)) offenders.push(`${sel} draws ${p}: ${v}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
