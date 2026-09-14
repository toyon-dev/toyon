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
 * count: the rows reverse as flex items, and the four things a pair cannot carry are restated
 * in the mirrored block: the rows' order, the marker's side, the seam with its clip and shadow,
 * and the digits' edge.
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
    expect(declsOf(rules, ".rail:hover .rail-panel").get("box-shadow")).toMatch(/^-10px /);
    expect(declsOf(rules, `${MIRROR} .rail:hover .rail-panel`).get("box-shadow")).toMatch(/^10px /);
    const marker = declsOf(rules, `${MIRROR} .rail .rail-item::before`);
    expect(marker.get("left")).toBe("auto");
    expect(marker.get("right")).toBe("var(--row-edge-x, 0)");
    expect(declsOf(rules, `${MIRROR} .rail .rail-item`).get("flex-direction")).toBe("row-reverse");
    expect(declsOf(rules, ".rail-count").get("text-align")).toBe("right");
    expect(declsOf(rules, `${MIRROR} .rail .rail-count`).get("text-align")).toBe("left");
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
  test("the installed app's zen strip keeps the zen toggle in either cluster", async () => {
    const rules = cssRules(await shellCss());
    const hidden = rules.filter((r) => r.decls.get("display") === "none").flatMap((r) => r.selectors);
    expect(hidden).toContain(".app.zen .bar-toggles > :not(.bar-zen)");
    expect(hidden).toContain(".app.zen .bar-tools > :not(.bar-zen)");
    expect(hidden).toContain(".app.zen .bar-lead > :not(.bar-toggles)");
  });
});
