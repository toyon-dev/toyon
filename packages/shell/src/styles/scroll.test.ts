import { describe, expect, test } from "bun:test";
import { cssRules, declsOf, shellCss } from "./cssRules.ts";

/**
 * The browser's swipe back and forward is a sideways overscroll reaching the viewport, and the
 * shell's viewport once said none on both axes to stop the window bouncing, which took the swipe
 * with it. The lock is the vertical axis alone: the window still does not bounce and a pull does
 * not reload the page, and a swipe over the preview walks that page's history.
 */

describe("the viewport's overscroll", () => {
  test("locks the vertical axis alone, so the swipe back reaches the browser", async () => {
    const decls = declsOf(cssRules(await shellCss()), "html:not([data-framed])");
    expect(decls.get("overscroll-behavior-y")).toBe("none");
    expect(decls.has("overscroll-behavior")).toBe(false);
    expect(decls.has("overscroll-behavior-x")).toBe(false);
  });
});
