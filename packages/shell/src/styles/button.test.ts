import { describe, expect, test } from "bun:test";
import { cssRules, shellCss } from "./cssRules.ts";

/**
 * The drift this exists to stop, which the written rule did not:
 *
 * .btn sets padding: 1px 8px. Ten semantic classes then set their own on top of it, in ten values,
 * four of those near-misses of a 4px 8px nobody had written down. Three of the ten landed on one
 * day, with "a semantic class adds color only" already written down as the rule, because prose in a
 * markdown file is not something a diff runs into.
 *
 * The silent part was worse than the count. An AskCard option was `btn btn-outline picker-item ask-opt`
 * and three of those four declare padding at equal specificity, so the winner was whichever sat
 * lowest in a 2400-line stylesheet, and the button quietly took a list row's min-height with it.
 *
 * Colour went the same way once the box was fixed. Twenty classes held seven colour values between
 * them, two of which restated what .btn-icon already set and so did nothing at all, which is what
 * an open escape hatch produces. So Button owns colour through a closed `tone`, and `className` is
 * left for how a button sits in its parent: a max-width, a flex-shrink, a margin. That is genuinely
 * the surface's business; the button's own appearance is not.
 *
 * So a class reaching a button may set neither the box nor a resting colour. State rules (:hover,
 * .on, :disabled) may still name a colour where one is genuinely unique, as .deep-link's blue
 * hover is. The one-offs below are real and each costs a deliberate line here rather than being
 * something you can do by accident. A chip that is not pressable (.pick-chip, .picker-chip: a div and a
 * span) is not a button and never reaches this test.
 */

/** the box: what a size owns */
const BOX = ["padding", "padding-top", "padding-bottom", "padding-left", "padding-right", "height", "min-height"];

/** the primitives: Button's sizes, variants and tones, and Field's sizes and faces */
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
  ".field",
  ".field-md",
  ".field-lg",
  ".field-ui",
  ".field-bare",
]);

/**
 * Controls that are deliberately not one of the sizes, each for a reason:
 * - .setup-add is a bare text link in a form, no horizontal box at all
 * - .jump-down is a floating pill over the transcript, sized to clear the composer
 * - .rail-new and .rail-disc-head are full-width rail rows that happen to be buttons
 * - .bar-path is the address strip: chrome, so quieter at rest than a form field, with the bar's
 *   own inset
 */
const ONE_OFFS = new Set([".setup-add", ".jump-down", ".rail-new", ".rail-disc-head", ".bar-path"]);

/**
 * A raw <button> is a row, or one of three inline controls that are text rather than a chip:
 * .pick-open is a link inside a chip's sentence, .dl.more the last line of a diff block, and the
 * rail's two full-width rows are above. Anything else pressable is a Button or an IconButton.
 */
const RAW_BUTTON_OK = new Set([
  "row",
  "picker-item",
  "design-row",
  "rail-new",
  "rail-disc-head",
  "jump-down",
  "pick-open",
  "dl",
]);

type Tag = { kind: string; words: string[]; text: string };

/** every control's opening tag, with the static words of its className */
function controls(src: string): Tag[] {
  const out: Tag[] = [];
  for (const m of src.matchAll(/<(Button|IconButton|Field|TextArea|button|input|textarea)\b/g)) {
    // walk to the end of the opening tag, so a className full of braces stays in one piece
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const text = src.slice(m.index, i);
    out.push({ kind: m[1]!, words: classWords(text), text });
  }
  return out;
}

/** the class names an opening tag writes: a quoted className, the static text and quoted strings
 * of a template, or the quoted strings handed to cx(). Identifiers inside `${}` are not classes. */
function classWords(tag: string): string[] {
  const cn = tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cx\(([^)]*)\))/);
  if (!cn) return [];
  const words = (s: string) => s.match(/[a-z][\w-]*/g) ?? [];
  const quoted = (s: string) => [...s.matchAll(/"([^"]*)"/g)].flatMap((q) => words(q[1] ?? ""));
  if (cn[1] !== undefined) return words(cn[1]);
  if (cn[2] !== undefined) return [...words(cn[2].replace(/\$\{[^}]*\}/g, " ")), ...quoted(cn[2])];
  return quoted(cn[3] ?? "");
}

describe("a control's box and its resting colour", () => {
  test("belong to Button and Field, so a surface class is left with how it sits in its parent", async () => {
    const onAControl = new Set<string>();
    const raw: string[] = [];
    for (const file of new Bun.Glob("**/*.tsx").scanSync({ cwd: new URL("..", import.meta.url).pathname })) {
      if (file.endsWith("ui/Button.tsx") || file.endsWith("ui/Field.tsx")) continue;
      const src = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
      for (const t of controls(src)) {
        if (t.kind === "button" && !t.words.some((w) => RAW_BUTTON_OK.has(w)))
          raw.push(`${file}: <button> wearing "${t.words.join(" ")}"`);
        // a checkbox, radio or file input is not a field; anything else typed into is one
        if ((t.kind === "input" || t.kind === "textarea") && !/type="(checkbox|radio|file)"/.test(t.text)) {
          raw.push(`${file}: <${t.kind}> that is not a Field`);
        }
        // a raw <button> is a row, and a row's box is the row idiom's, not Button's
        if (t.kind === "button" && !t.words.includes("btn") && !t.words.includes("btn-icon")) continue;
        for (const w of t.words) onAControl.add(`.${w}`);
      }
    }
    expect(raw.sort()).toEqual([]);

    const offenders: string[] = [];
    for (const rule of cssRules(await shellCss())) {
      const named = BOX.filter((p) => rule.decls.has(p));
      if (rule.decls.has("color")) named.push("a resting colour");
      if (named.length === 0) continue;
      for (const sel of rule.selectors) {
        // a bare single-class rule only: `.foo { … }`. A state or descendant rule is scoped, and
        // a unique hover colour is still the surface's to name.
        const m = sel.match(/^\.([a-z][\w-]*)$/);
        if (!m) continue;
        const cls = `.${m[1]}`;
        if (PRIMITIVES.has(cls) || ONE_OFFS.has(cls) || !onAControl.has(cls)) continue;
        offenders.push(`${cls} sets ${named.join(", ")}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
