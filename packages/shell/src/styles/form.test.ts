import { describe, expect, test } from "bun:test";
import { cssRules, shellCss } from "./cssRules.ts";

/**
 * Form parts: one line that must not move, and parts that neither re-inset nor ground the view.
 *
 * The line first. On the first run a person types a project's name into a field, presses create,
 * and a moment later reads that same name as the title of the project it made. Those are two
 * elements in two views, and the whole first-run screen is built so the words do not move or
 * resize between them. What holds it is that both sides take `--type-ui-xl` and nothing else in
 * the shell does. That was a comment for a year; a third selector taking the same size, or either
 * side quietly taking a different one, breaks it invisibly, because the two are never on screen
 * together for anyone to compare.
 *
 * Then the parts themselves. The column is View's and view.test.ts holds it, so a part may say how
 * it sits but not where the column's edges are, and no part may draw the ground the column refuses:
 * a box around the first thing anyone writes reads as a form to fill in rather than a page to write
 * on. Taking a ground away is allowed, so `none` and friends pass; painting one is the drift.
 */

/** the two sides of the line: the field a name is typed into, and the title it is read as after */
const ARRIVAL = new Set([".field-lead", ".form-title"]);

/**
 * The parts, which may say how they sit but not where the column's edges are.
 * FormRow's parts (`form-row`, `form-label`, `form-control`) are not on this list: a row inside a
 * form is its own thing, and its label column is a width it owns.
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

describe("the form parts", () => {
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

  test("no part re-insets the view, and the title line sits on one baseline", async () => {
    const offenders: string[] = [];
    let head = false;
    for (const rule of cssRules(await shellCss())) {
      for (const sel of rule.selectors) {
        if (sel === ".form-head") head = rule.decls.get("align-items") === "baseline";
        if (!PARTS.has(sel)) continue;
        for (const p of BOX) {
          // the body is the one part that names a height of its own: it is a box to write in, and
          // its floor is what gives the region a shape before a word is in it
          if (p === "min-height") continue;
          if (rule.decls.has(p)) offenders.push(`${sel} sets ${p}, but the column is .view's`);
        }
      }
    }
    if (!head) offenders.push(".form-head must sit the title and its neighbour on one baseline");
    expect(offenders.sort()).toEqual([]);
  });

  test("no form part draws a ground", async () => {
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
