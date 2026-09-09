import { describe, expect, test } from "bun:test";

/**
 * The drift this exists to stop, which the written rule did not:
 *
 * .btn sets padding: 1px 8px. Ten semantic classes then set their own on top of it, in ten values,
 * and four of those (2px 8px, 3px 7px, 2px 10px, 1px 7px) were near-misses of a 4px 8px nobody had
 * written down. Three of the ten landed on one day, with "a semantic class adds color only" already
 * written down as the rule, because prose in a markdown file is not something a diff runs into.
 *
 * The silent part was worse than the count. An AskCard option is `btn btn-outline qo-item ask-opt`
 * and three of those four declare padding at equal specificity, so the winner was whichever sat
 * lowest in a 2400-line stylesheet, and the button quietly took a list row's min-height with it.
 *
 * So the box belongs to the primitive and to Button's size prop, and a class that lands on a .btn
 * may add colour, type and how it sits in its parent, but not its own metrics. The one-offs below
 * are real and each costs a deliberate line here rather than being something you can do by
 * accident. A chip that is not pressable (.pick-chip, .lp-chip: a div and a span) is not a button
 * and never reaches this test.
 */

/** the box: what a size owns. A semantic class naming any of these is the mistake. */
const BOX = ["padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "height", "min-height"];

/** the primitives themselves, and the three sizes */
const PRIMITIVES = new Set([".btn", ".btn-md", ".btn-lg", ".btn-icon"]);

/**
 * Controls that are deliberately not one of the three sizes, each for a reason:
 * - .setup-add is a bare text link in a form, no horizontal box at all
 * - .jump-down is a floating pill over the transcript, sized to clear the composer
 * - .new-wt and .disc-head are full-width rail rows that happen to be buttons
 * - .dock-tab hangs its label off the top edge of the dock, so its padding is asymmetric
 */
const ONE_OFFS = new Set([".setup-add", ".jump-down", ".new-wt", ".disc-head", ".dock-tab"]);

describe("the box of a button", () => {
  test("belongs to the primitive, so a semantic class only adds colour on top", async () => {
    const files = await Promise.all(
      ["base.css", "surfaces.css"].map((f) => Bun.file(new URL(f, import.meta.url)).text()),
    );
    const css = files.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

    // Which classes ride a button is a fact about the JSX, not the CSS: nobody writes
    // `.btn.ship-btn` in a stylesheet, they write className="btn btn-outline ship-btn". So the
    // className strings are the source of truth, and reading the CSS instead is how an earlier
    // draft of this test passed a padding on .ship-btn without noticing.
    const onAButton = new Set<string>();
    for (const file of new Bun.Glob("**/*.tsx").scanSync({ cwd: new URL("..", import.meta.url).pathname })) {
      const src = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        // a template's `${x ? "on" : ""}` contributes its literals like any other word
        const words: string[] = (m[1] ?? m[2] ?? "").match(/[a-z][\w-]*/g) ?? [];
        if (!words.includes("btn") && !words.includes("btn-icon")) continue;
        for (const w of words) onAButton.add("." + w);
      }
    }

    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2] ?? "";
      const named = BOX.filter((p) => new RegExp(`(?:^|;|\\n)\\s*${p}\\s*:`).test(body));
      if (named.length === 0) continue;
      for (const part of (rule[1] ?? "").split(",")) {
        const sel = part.trim().replace(/\s+/g, " ");
        // only bare single-class rules: `.foo { padding }`. A descendant or state rule is scoped.
        const m = sel.match(/^\.([a-z][\w-]*)$/);
        if (!m) continue;
        const cls = "." + m[1];
        if (PRIMITIVES.has(cls) || ONE_OFFS.has(cls) || !onAButton.has(cls)) continue;
        offenders.push(`${cls} sets ${named.join(", ")}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
