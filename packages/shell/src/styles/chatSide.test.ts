import { describe, expect, test } from "bun:test";
import { cssRules, declsOf, shellCss } from "./cssRules.ts";

/**
 * The chat side setting mirrors the workbench: with the chat on the left the row reads rail, chat,
 * centre, changes. The row and the bar reorder in the App; the rail is drawn for one hand in CSS
 * and mirrored by a switch, and the switch only works while every side-bearing rule in rail.css
 * is written through the near/far pairs it swaps. A bare `right: 0` on a pin, or a seam whose
 * mirror was never written, fails quietly: the rail still draws, on the wrong side of itself.
 *
 * Not direction: rtl, which would reorder the bidi-neutral characters in a branch name or a
 * count: the dot alone crosses the row by flex order, so the row still reads name, badges, counts
 * toward the control column, and the three things a pair cannot carry are restated in the mirrored
 * block: the dot's seat, the marker's side, and the seam with its clip and shadow. The bar is not
 * mirrored: only the two panel toggles trade ends (TopBar.tsx).
 */

const MIRROR = '.app[data-chat-side="left"]';
const PINS = [".rail-panel", ".rail-list", ".rail-foot", ".rail-gut", ".rail .rail-main-strip"];

describe("the rail's side is one switch", () => {
  test("every pin is written through a near or far pair", async () => {
    const rules = cssRules(await shellCss());
    for (const pin of PINS) {
      const decls = declsOf(rules, pin);
      expect([pin, decls.get("left")]).toEqual([pin, expect.stringMatching(/^var\(--rail-(near|far)-l\)$/)]);
      expect([pin, decls.get("right")]).toEqual([pin, expect.stringMatching(/^var\(--rail-(near|far)-r\)$/)]);
    }
  });
  test("the rail declares the pairs and the mirror swaps them", async () => {
    const rules = cssRules(await shellCss());
    const rail = declsOf(rules, ".rail");
    const mirror = declsOf(rules, `${MIRROR} .rail`);
    const pairs: [string, string][] = [
      ["--rail-near-r", "--rail-near-l"],
      ["--rail-far-r", "--rail-far-l"],
      ["--rail-pad-l", "--rail-pad-r"],
      ["--rail-dot-ml", "--rail-dot-mr"],
    ];
    for (const [a, b] of pairs) {
      expect(rail.get(a)).toBeDefined();
      expect(mirror.get(a)).toBe(rail.get(b));
      expect(mirror.get(b)).toBe(rail.get(a));
    }
  });
  test("the mirror restates what a pair cannot carry", async () => {
    const rules = cssRules(await shellCss());
    expect(declsOf(rules, ".rail-panel").get("clip-path")).toBe("inset(0 0 0 -32px)");
    expect(declsOf(rules, `${MIRROR} .rail .rail-panel`).get("clip-path")).toBe("inset(0 -32px 0 0)");
    // the shadow's offset is a pair: a box-shadow restated under the mirror would outrank the
    // kept-open rail's box-shadow: none
    expect(declsOf(rules, ".rail:hover .rail-panel").get("box-shadow")).toMatch(/^var\(--rail-shadow-x\) /);
    expect(declsOf(rules, ".rail").get("--rail-shadow-x")).toBe("-10px");
    expect(declsOf(rules, `${MIRROR} .rail`).get("--rail-shadow-x")).toBe("10px");
    expect(rules.some((r) => r.selectors.includes(`${MIRROR} .rail:hover .rail-panel`))).toBe(false);
    const marker = declsOf(rules, `${MIRROR} .rail .rail-item::before`);
    expect(marker.get("left")).toBe("auto");
    expect(marker.get("right")).toBe("var(--row-edge-x, 0)");
    // the dot crosses, the row does not: the counts keep their order and their edge on both hands
    expect(declsOf(rules, `${MIRROR} .rail .rail-item .dot`).get("order")).toBe("-1");
    expect(declsOf(rules, `${MIRROR} .rail .rail-glyph`).get("order")).toBe("-1");
    const mirrored = (sel: string) => rules.some((r) => r.selectors.includes(`${MIRROR} .rail ${sel}`));
    expect(mirrored(".rail-item")).toBe(false);
    expect(mirrored(".rail-counts")).toBe(false);
    expect(mirrored(".rail-count")).toBe(false);
    expect(declsOf(rules, ".rail-count").get("text-align")).toBe("right");
  });
  test("every seam has its mirror, each in its owner's stylesheet", async () => {
    const rules = cssRules(await shellCss());
    const seams: [string, string, string, string][] = [
      [".changes-dock", `${MIRROR} .changes-dock`, "border-right", "border-left"],
      [".chat-dock", `${MIRROR} .chat-dock`, "border-left", "border-right"],
      [".rail-panel", `${MIRROR} .rail .rail-panel`, "border-left", "border-right"],
    ];
    for (const [sel, mirrored, own, other] of seams) {
      expect(declsOf(rules, sel).get(own)).toMatch(/^1px solid /);
      const m = declsOf(rules, mirrored);
      expect(m.get(own)).toBe("0");
      expect(m.get(other)).toMatch(/^1px solid /);
    }
  });
});
