import { describe, expect, test } from "bun:test";
import { cssRules, declsOf, shellCss } from "./cssRules.ts";

/**
 * The docks row fits the window it is in, not the one its widths were dragged in. The installed
 * app opens at the size its own window last had, so a chat dock sized in a wide browser tab once
 * ran the row past the window's edge: the rail off screen, and the whole row sliding back into
 * view when a dock closed. The fit is the row's CSS and nothing else, and each part of it has
 * failed quietly before, which is what this test is for.
 *
 * The row is a grid item, and a grid item's automatic minimum is its content, so without a
 * min-width of 0 the column grows to hold the docks and nothing below ever runs. A dock's width is
 * its basis and it gives from there, down to the row's floor. The centre keeps its basis and never
 * gives, so what the docks frame stays in view. Everything else in the row keeps its width, so the
 * docks are the only thing that gives.
 */

describe("the docks row fits the window", () => {
  test("the row can be narrower than the docks it holds", async () => {
    const decls = declsOf(cssRules(await shellCss()), ".docks");
    expect(decls.get("min-width")).toBe("0");
    expect(decls.get("--dock-min")).toBeDefined();
  });
  test("a dock gives from its width, down to the row's floor", async () => {
    const rules = cssRules(await shellCss());
    for (const dock of [".changes-dock", ".chat-dock"]) {
      const decls = declsOf(rules, dock);
      expect(decls.get("flex")).toBe("0 1 auto");
      expect(decls.get("min-width")).toBe("var(--dock-min)");
    }
  });
  test("the centre keeps its floor and never gives", async () => {
    const decls = declsOf(cssRules(await shellCss()), ".center");
    expect(decls.get("flex")).toMatch(/^1 0 \d+px$/);
    expect(decls.get("min-width")).toBe("0");
  });
  test("the rail and the handles keep their width, so only the docks give", async () => {
    const rules = cssRules(await shellCss());
    for (const fixed of [".rail", ".dock-resize"]) expect(declsOf(rules, fixed).get("flex-shrink")).toBe("0");
  });
});
