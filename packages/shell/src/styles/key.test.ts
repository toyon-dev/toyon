import { describe, expect, test } from "bun:test";
import { cssRules, declsOf, shellCss } from "./cssRules.ts";

/**
 * A document's own HTML may name a key (`<kbd>`), and the sanitizer leaves it no class, so the
 * app's `.kbd` never reaches it: the element is dressed by the markdown rules, as the boxed key
 * (`.kbd-chip`). Two things about it are easy to lose. The browser sets the element in monospace,
 * and the mono stack has no ⌘ or ⇧. And the app hides its own hints on a touch screen, where a
 * chord is a promise the phone cannot keep; a document is describing a key, so it stays.
 */

/** a selector that reaches the bare element, whatever it is nested under */
const namesElement = (sel: string) => /(^|[\s>+~])kbd(?![\w-])/.test(sel);

describe("a key a document names", () => {
  test("is the chip, in the UI face at both reading sizes", async () => {
    const rules = cssRules(await shellCss());
    const prose = declsOf(rules, ".md kbd");
    expect(prose.get("font")).toBe("var(--type-ui-sm)");
    expect(prose.get("background")).toBe("var(--sunken)");
    expect(prose.get("border")).toBe("1px solid var(--border0)");
    expect(prose.get("border-radius")).toBe("var(--radius)");
    expect(declsOf(rules, ".md-preview kbd").get("font")).toBe("var(--type-ui-sm-phone)");
  });

  test("wears the one box the app's boxed key does", async () => {
    const rules = cssRules(await shellCss());
    const prose = declsOf(rules, ".md kbd");
    const chip = declsOf(rules, ".kbd-chip");
    for (const prop of ["padding", "color", "background", "border", "border-radius"]) {
      expect(`${prop}: ${chip.get(prop)}`).toBe(`${prop}: ${prose.get(prop)}`);
    }
  });

  test("stays inline, so the paragraph keeps its line height", async () => {
    const offenders: string[] = [];
    for (const r of cssRules(await shellCss())) {
      for (const sel of r.selectors) {
        if (!namesElement(sel)) continue;
        for (const prop of ["display", "line-height", "margin", "vertical-align"]) {
          if (r.decls.has(prop)) offenders.push(`${sel} { ${prop} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("is hidden on touch by the app's class alone", async () => {
    const hidden = cssRules(await shellCss())
      .filter((r) => r.decls.get("display") === "none")
      .flatMap((r) => r.selectors)
      .filter((sel) => sel.includes("[data-touch]") && /kbd/.test(sel));
    expect(hidden).toEqual(["[data-touch] .kbd"]);
  });
});
