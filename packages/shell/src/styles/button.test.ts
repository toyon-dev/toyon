import { describe, expect, test } from "bun:test";

/**
 * The drift this exists to stop, which the written rule did not:
 *
 * .btn sets padding: 1px 8px. Ten semantic classes then set their own on top of it, in ten values,
 * four of those near-misses of a 4px 8px nobody had written down. Three of the ten landed on one
 * day, with "a semantic class adds color only" already written down as the rule, because prose in a
 * markdown file is not something a diff runs into.
 *
 * The silent part was worse than the count. An AskCard option was `btn btn-outline qo-item ask-opt`
 * and three of those four declare padding at equal specificity, so the winner was whichever sat
 * lowest in a 2400-line stylesheet, and the button quietly took a list row's min-height with it.
 *
 * Colour went the same way once the box was fixed. Twenty classes held seven colour values between
 * them; .rb-btn set the text1 that .btn-icon already sets, and .toggle restated .btn-icon.on. Both
 * were classes that did nothing, which is what an open escape hatch produces. So Button owns colour
 * through a closed `tone`, and `className` is left for how a button sits in its parent: a
 * max-width, a flex-shrink, a margin. That is genuinely the surface's business; the button's own
 * appearance is not.
 *
 * So a class reaching a button may set neither the box nor a resting colour. State rules (:hover,
 * .on, :disabled) may still name a colour where one is genuinely unique, as .deep-link's blue
 * hover is. The one-offs below are real and each costs a deliberate line here rather than being
 * something you can do by accident. A chip that is not pressable (.pick-chip, .lp-chip: a div and a
 * span) is not a button and never reaches this test.
 */

/** the box: what a size owns */
const BOX = ["padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "height", "min-height"];

/** the primitives: sizes, variants and tones */
const PRIMITIVES = new Set([
  ".btn",
  ".btn-md",
  ".btn-lg",
  ".btn-icon",
  ".btn-outline",
  ".btn-field",
  ".btn-mono",
  ".tone-primary",
  ".tone-quiet",
  ".tone-danger",
  ".tone-chrome",
]);

/**
 * Controls that are deliberately not one of the three sizes, each for a reason:
 * - .setup-add is a bare text link in a form, no horizontal box at all
 * - .jump-down is a floating pill over the transcript, sized to clear the composer
 * - .new-wt and .disc-head are full-width rail rows that happen to be buttons
 */
const ONE_OFFS = new Set([".setup-add", ".jump-down", ".new-wt", ".disc-head"]);

/** `<Button className={...}>`, `<IconButton …>`, and a raw `<button>` still wearing a primitive */
function classesReachingAButton(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<(Button|IconButton|button)\b/g)) {
    // walk to the end of the opening tag, so a className full of braces stays in one piece
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(m.index, i);
    const cn = tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/);
    if (!cn) continue;
    const words: string[] = (cn[1] ?? cn[2] ?? "").match(/[a-z][\w-]*/g) ?? [];
    // a raw <button> only counts when it is actually wearing a primitive; otherwise it is a row
    if (m[1] === "button" && !words.includes("btn") && !words.includes("btn-icon")) continue;
    out.push(...words);
  }
  return out;
}

describe("a button's box and its resting colour", () => {
  test("belong to Button, so a surface class is left with how it sits in its parent", async () => {
    const files = await Promise.all(
      ["base.css", "surfaces.css"].map((f) => Bun.file(new URL(f, import.meta.url)).text()),
    );
    const css = files.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

    const onAButton = new Set<string>();
    for (const file of new Bun.Glob("**/*.tsx").scanSync({ cwd: new URL("..", import.meta.url).pathname })) {
      if (file.endsWith("ui/Button.tsx")) continue;
      const src = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
      for (const w of classesReachingAButton(src)) onAButton.add(`.${w}`);
    }

    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2] ?? "";
      const named = BOX.filter((p) => new RegExp(`(?:^|;|\\n)\\s*${p}\\s*:`).test(body));
      if (/(?:^|;|\n)\s*color\s*:/.test(body)) named.push("a resting colour");
      if (named.length === 0) continue;
      for (const part of (rule[1] ?? "").split(",")) {
        // a bare single-class rule only: `.foo { … }`. A state or descendant rule is scoped, and
        // a unique hover colour is still the surface's to name.
        const m = part
          .trim()
          .replace(/\s+/g, " ")
          .match(/^\.([a-z][\w-]*)$/);
        if (!m) continue;
        const cls = `.${m[1]}`;
        if (PRIMITIVES.has(cls) || ONE_OFFS.has(cls) || !onAButton.has(cls)) continue;
        offenders.push(`${cls} sets ${named.join(", ")}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
