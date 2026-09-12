import { describe, expect, test } from "bun:test";
import { cssRules, shellCss } from "./cssRules.ts";

/**
 * The form dress: one column, no ground, and one line that must not move.
 *
 * The line first. On the first run a person types a project's name into a field, presses create,
 * and a moment later reads that same name as the title of the project it made. Those are two
 * elements in two views, and the whole first-run screen is built so the words do not move or
 * resize between them. What holds it is that both sides take `--type-ui-xl` and nothing else in
 * the shell does. That was a comment for a year; a third selector taking the same size, or either
 * side quietly taking a different one, breaks it invisibly, because the two are never on screen
 * together for anyone to compare.
 *
 * Then the ground. A form is groundless on purpose: a box drawn around the first thing anyone
 * writes reads as a form to fill in rather than a page to write on. Setup wore a card for a year
 * and reads as a different product because of it. Taking a ground away is the point, so `none`
 * and friends pass; painting one is the drift.
 */

/** the two sides of the line: the field a name is typed into, and the title it is read as after */
const ARRIVAL = new Set([".field-lead", ".form-title"]);

/**
 * The rest of the dress, which may say how a part sits but not where the column's edges are.
 * FormRow's parts (`form-row`, `form-label`, `form-control`, `form-actions`, `form-dest`) are not
 * on this list: a row inside a form is its own thing, and its label column is a width it owns.
 */
const PARTS = new Set([".form-title", ".form-head", ".form-body", ".form-body-lg", ".form-knobs", ".form-go"]);
const BOX = ["padding", "padding-top", "padding-bottom", "padding-inline", "width", "margin", "margin-top"];

const GROUND = [
  "background",
  "background-color",
  "border",
  "border-top",
  "border-bottom",
  "border-left",
  "border-right",
  "border-color",
  "border-radius",
  "box-shadow",
];
/** taking a ground away is what this dress is for, so a removal is not a violation */
const REMOVED = new Set(["none", "transparent", "0", "unset", "initial", "0px"]);

describe("the form dress", () => {
  test("the name typed and the title read are one line at one size", async () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const rule of cssRules(await shellCss())) {
      if (rule.decls.get("font") !== "var(--type-ui-xl)") continue;
      for (const sel of rule.selectors) {
        seen.add(sel);
        if (!ARRIVAL.has(sel))
          offenders.push(`${sel} also sets --type-ui-xl, so the arrival size is no longer one pair`);
      }
    }
    for (const sel of ARRIVAL) if (!seen.has(sel)) offenders.push(`${sel} no longer sets font: var(--type-ui-xl)`);
    expect(offenders.sort()).toEqual([]);
  });

  test("the column is declared once, and its parts do not re-inset it", async () => {
    const offenders: string[] = [];
    let head = false;
    const measures: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      for (const sel of rule.selectors) {
        if (sel === ".form-head") head = rule.decls.get("align-items") === "baseline";
        if (rule.decls.get("width")?.includes("--form-measure")) measures.push(sel);
        if (!PARTS.has(sel)) continue;
        for (const p of BOX) {
          // the body is the one part that names a height of its own: it is a box to write in, and
          // its floor is what gives the region a shape before a word is in it
          if (p === "min-height") continue;
          if (rule.decls.has(p)) offenders.push(`${sel} sets ${p}, but the column is .form's`);
        }
      }
    }
    if (!head) offenders.push(".form-head must sit the title and its neighbour on one baseline");
    // the measure is the dress. `.setup-pane` was a second copy of this column for a year, and the
    // two drifted apart by a top anchor nobody meant to make different.
    if (measures.join() !== ".form") offenders.push(`the measure is declared by ${measures.join(", ") || "nothing"}`);
    expect(offenders.sort()).toEqual([]);
  });

  test("a form draws no ground", async () => {
    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      for (const sel of rule.selectors) {
        if (!/(^|\s|>)\.form(-[\w-]+)?\b/.test(sel)) continue;
        for (const p of GROUND) {
          const v = rule.decls.get(p);
          if (v && !REMOVED.has(v)) offenders.push(`${sel} draws ${p}: ${v}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
