import { describe, expect, test } from "bun:test";
import { cssRules, declsOf, shellCss } from "./cssRules.ts";

/**
 * A heading in rendered markdown is marked one of two ways. A document's h1 and h2 climb the type
 * ladder, and the mono inside them keeps its own weight. Every other heading, all six in a reply
 * and h3 down in a document, stays at the body size and is marked by weight alone, so it hands
 * that weight to the mono inside it: a heading that is only a backticked name would otherwise be a
 * chip between two paragraphs, with neither size nor weight to say what it is.
 */

/** `:is(a, b)` written out, so a rule is found by the plain selector it reaches */
function written(sel: string): string[] {
  const group = /:is\(([^()]*)\)/.exec(sel);
  if (!group) return [sel];
  return group[1]!.split(",").flatMap((alt) => written(sel.replace(group[0], alt.trim())));
}

/** every selector that states a weight, and the weight it states */
async function weights(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of cssRules(await shellCss())) {
    const weight = r.decls.get("font-weight");
    if (weight) for (const sel of r.selectors.flatMap(written)) out.set(sel, weight);
  }
  return out;
}

const MONO = ["code", "a.file-link"];

describe("the mono in a markdown heading", () => {
  test("takes the heading's weight where weight is all that marks the heading", async () => {
    const stated = await weights();
    const reach = [
      ...["h1", "h2"].map((h) => `.md:not(.md-preview) ${h}`),
      ...["h3", "h4", "h5", "h6"].map((h) => `.md ${h}`),
    ];
    for (const heading of reach) {
      for (const mono of MONO) {
        const sel = `${heading} ${mono}`;
        expect(`${sel}: ${stated.get(sel)}`).toBe(`${sel}: inherit`);
      }
    }
  });

  test("keeps its own weight, and the chip's proportion, in a document's h1 and h2", async () => {
    const stated = await weights();
    const rules = cssRules(await shellCss());
    for (const h of ["h1", "h2"]) {
      for (const mono of MONO) {
        expect(stated.has(`.md ${h} ${mono}`)).toBe(false);
        expect(stated.has(`.md-preview ${h} ${mono}`)).toBe(false);
      }
      expect(declsOf(rules, `.md-preview ${h} code`).get("font-size")).toBe("0.8em");
    }
  });
});
