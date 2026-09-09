import { describe, expect, test } from "bun:test";

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
  ".wt-rail:hover .disc-head",
  ".wt-rail.hold .disc-head",
  ".wt-rail.open .disc-head",
];

/** a child that lifts, but to a tier of its own: the transcript reads its hint up to text0, and a
 * search hit's location goes with the code line it labels, which is the thing you are reading */
const LIFTS_ELSEWHERE = [".tool-row .tool-name", ".tool-row .tool-icon", ".tool-row .tool-hint", ".sr-loc"];

/** the token as a colour rather than as a tier. A status dot that shifted under the pointer would
 * read as the proc changing state, so these three must not ride the seat */
const NOT_A_TIER = [".dot.starting", ".dot.discovered", ".dot.unseen"];

/** text on something that never lifts: an empty state, a hint, a heading, a control switched off */
const NEVER_LIFTS = [
  ".ask-answered",
  ".ask-card.done",
  ".ask-card.done .ask-lead",
  ".ask-desc",
  ".ask-header",
  ".ask-keys",
  ".ask-note-btn",
  ".ask-skip",
  ".auth-card.done",
  ".auth-card.done .auth-title",
  ".blocked-row .tool-hint",
  ".btn-icon:disabled",
  ".btn-outline:disabled",
  ".btn:disabled",
  ".center .empty",
  ".chat-hint",
  ".combine-btn:disabled",
  ".composer-ghost",
  ".crash-body",
  ".deep-link",
  ".design-cell-note",
  '.design-cell[data-kind="color"] .design-cell-value',
  ".design-gap",
  ".design-note",
  ".design-tag",
  ".design-variant",
  ".dock-empty",
  ".dock-section-title",
  ".form-hint",
  ".import-error",
  ".import-idle",
  ".keys-h",
  ".lp-ghost",
  ".lp-keys",
  ".msg-thinking",
  ".new-wt .kbd-hint",
  ".np-dest",
  ".pick-chip .pick-file",
  ".pick-chip button",
  ".prompt-box .title",
  ".set-v:disabled",
  ".set-v:disabled:hover",
  ".setup-aside",
  ".status-bar",
  ".tool-row .dl.meta",
  ".tool-row .dl.more",
  ".variants-row",
  ".zen-title",
];

const ALLOWED = new Set([".row-dim", ...ROW_AT_REST, ...LIFTS_ELSEWHERE, ...NOT_A_TIER, ...NEVER_LIFTS]);

describe("the skip tier inside a row", () => {
  test("is spelled .row-dim, so it lifts when the seat under it does", async () => {
    const files = await Promise.all(
      ["base.css", "surfaces.css"].map((f) => Bun.file(new URL(f, import.meta.url)).text()),
    );
    const css = files.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1] ?? "";
      const body = rule[2] ?? "";
      if (!/(?<![-\w])color:\s*var\(--text2\)/.test(body)) continue;
      for (const part of selector.split(",")) {
        const sel = part.trim().replace(/\s+/g, " ");
        if (sel && !ALLOWED.has(sel)) offenders.push(sel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
