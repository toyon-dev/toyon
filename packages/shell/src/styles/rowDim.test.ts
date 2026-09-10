import { describe, expect, test } from "bun:test";
import { cssRules, shellCss } from "./cssRules.ts";

/**
 * The bug this exists to stop, which landed three separate times before anyone caught it:
 *
 * A row lifts its seat on hover or when it is picked, and a child inside it goes on naming --text2.
 * text2 on element1 is 1.06:1, so that child does not go quiet, it disappears. It happened to a
 * changed file's directory, then to the same span in the picker, then to the design pane's count
 * and path, and the worktree row's "more" button was worse again: hidden until the row is hovered,
 * so it arrived at 1.44:1 and was invisible for as long as it existed. Each time the fix was one
 * more hand-written rule for that one child, which is why it kept happening.
 *
 * The rule is that a child sitting a tier below its row takes .row-dim and reads --row-dim-color,
 * which the row sets when its seat lifts. Naming --text2 directly inside a row is therefore the
 * mistake, and this is what says so before a screenshot does.
 *
 * Everything below is a rule that paints in the skip tier for a reason. Adding to it is fine and is
 * meant to cost a deliberate line in a diff rather than being something you can do by accident.
 */

/** the row's own resting colour: it is the seat, not a passenger on one */
const ROW_AT_REST = [
  ".row-quiet",
  ".tool-row",
  ".design-tail > summary",
  ".rail:hover .rail-disc-head",
  ".rail.hold .rail-disc-head",
  ".rail.pinned .rail-disc-head",
];

/** a child that lifts, but to a tier of its own: the transcript reads its hint up to text0, and a
 * search hit's location goes with the code line it labels, which is the thing you are reading */
const LIFTS_ELSEWHERE = [".tool-row .tool-name", ".tool-row .tool-icon", ".tool-row .tool-hint", ".search-loc"];

/** the token as a colour rather than as a tier. A status dot that shifted under the pointer would
 * read as the proc changing state, so these three must not ride the seat */
const NOT_A_TIER = [".dot.starting", ".dot.discovered", ".dot.unseen"];

/** text on something that never lifts: an empty state, a hint, a heading, a control switched off */
const NEVER_LIFTS = [
  /* the quiet tone: a way out, an aside, a link. It replaced .deep-link, .ask-note-btn and
     .ask-skip, which were each here for the same reason and are one rule now. No quiet button
     sits inside a row; if one ever does it takes .row-dim like any other passenger. */
  ".tone-quiet",
  ".ask-answered",
  ".ask-card.done",
  ".ask-card.done .ask-lead",
  ".ask-header",
  ".auth-card.done",
  ".auth-card.done .auth-title",
  ".blocked-row .tool-hint",
  ".btn-icon:disabled",
  ".btn-outline:disabled",
  ".btn:disabled",
  /* the spinner over a busy button is disabled's colour; it names it because the button's own
     colour is transparent under it, and a Button never sits inside a row */
  ".btn-busy > .spinner",
  ".center .empty",
  ".composer-ghost",
  ".crash-body",
  ".design-cell-note",
  '.design-cell[data-kind="color"] .design-cell-value',
  ".design-gap",
  ".design-note",
  ".design-tag",
  ".design-variant",
  ".empty",
  ".section-title",
  ".hint",
  ".import-error",
  ".import-idle",
  ".picker-ghost",
  ".key-hints",
  ".msg-thinking",
  ".rail-new .rail-new-kbd",
  ".form-dest",
  ".pick-chip .pick-file",
  ".pick-chip button",
  ".overlay-title",
  ".setup-aside",
  ".status-bar",
  ".tool-row .dl.meta",
  ".tool-row .dl.more",
  ".prompt-variants",
  ".bar-zen-title",
];

const ALLOWED = new Set([".row-dim", ...ROW_AT_REST, ...LIFTS_ELSEWHERE, ...NOT_A_TIER, ...NEVER_LIFTS]);

describe("the skip tier inside a row", () => {
  test("is spelled .row-dim, so it lifts when the seat under it does", async () => {
    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      if (rule.decls.get("color") !== "var(--text2)") continue;
      for (const sel of rule.selectors) if (!ALLOWED.has(sel)) offenders.push(sel);
    }
    expect(offenders).toEqual([]);
  });
});
