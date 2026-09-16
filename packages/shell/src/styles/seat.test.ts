import { describe, expect, test } from "bun:test";
import { type CssRule, cssRules, declsOf, shellCss } from "./cssRules.ts";

/**
 * A seat that lifts moves the ladder with it. A row painted on element0 or element1 still carries
 * whatever was standing on it, and a child that goes on naming --text2 there does not go quiet, it
 * disappears: text2 on element1 is 1.06:1. That landed four times in the transcript alone, each
 * fixed with one more hand-written rule for the one child somebody noticed, and the pickers had
 * four of their own with the file row's directory as the fifth nobody wrote.
 *
 * The rule now is that the seat redeclares the tiers and every passenger rides for free. These two
 * tests hold the seat's end of that: it moves both rungs, and it moves them by one.
 */

/** the two lines a seat declares, and the only two it may */
const LIFT: [string, string][] = [
  ["--text1", "var(--ink0)"],
  ["--text2", "var(--ink1)"],
];

/** Rules that paint an element colour without being a seat. A control is not a seat: it carries no
 * passengers, and its own colours say its state (button.css says why it holds them still). Neither
 * is a drag handle, which carries nothing at all. */
const NOT_A_SEAT = [
  ".btn:hover",
  ".btn-icon:hover",
  ".tone-chrome.on",
  ".jump-down",
  ".dock-resize:hover::after",
  ".dock-resize.active::after",
  ".pane-resize:hover",
  "body.resizing .pane-resize",
  ".rail-item .rail-badge.clickable:hover",
  ".rail-disc-item .rail-badge.clickable:hover",
  ".rail-item .rail-more:hover",
  ".rail-disc-item .rail-more:hover",
  ".rail-item.menu-open .rail-more",
  ".rail-disc-item.menu-open .rail-more",
];

/** Seats whose element also carries .row, so base.css lifts them and they say nothing themselves.
 * A surface that paints its own seat and is not a .row is not on this list and declares the lift. */
const IS_A_ROW = [".log-row", ".git-file", ".tree-row", ".rail-item", ".rail-disc-item", ".menu button"];

const lifts = (decls: Map<string, string>) => LIFT.every(([prop, value]) => decls.get(prop) === value);

describe("a lifted seat", () => {
  test("moves both rungs, and only by one", async () => {
    const wrong: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      // :root declares the ladder rather than moving it
      if (rule.selectors.includes(":root")) continue;
      if (!rule.decls.has("--text1") && !rule.decls.has("--text2")) continue;
      if (!lifts(rule.decls)) wrong.push(rule.selectors.join(", "));
    }
    expect(wrong).toEqual([]);
  });

  test("is declared by everything that paints one", async () => {
    const rules: CssRule[] = cssRules(await shellCss());
    const missing: string[] = [];
    for (const rule of rules) {
      const bg = rule.decls.get("background") ?? rule.decls.get("background-color");
      if (bg !== "var(--element0)" && bg !== "var(--element1)") continue;
      for (const sel of rule.selectors) {
        if (NOT_A_SEAT.includes(sel) || IS_A_ROW.some((row) => sel.startsWith(`${row}[`) || sel.startsWith(`${row}.`)))
          continue;
        // every rule naming this selector, since a seat may paint in one and lift in another
        if (!lifts(declsOf(rules, sel))) missing.push(sel);
      }
    }
    expect(missing).toEqual([]);
  });
});
