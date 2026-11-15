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

  // The editor scrolls sideways in script, and a browser left one wheel event of that gesture
  // takes it for the swipe. The root is marked while the pointer is over the editor, and the mark
  // is the same switch thrown the other way, on the sideways axis alone.
  test("holds the sideways axis while the pointer is over the editor", async () => {
    const decls = declsOf(cssRules(await shellCss()), "html[data-wheel-kept]");
    expect(decls.get("overscroll-behavior-x")).toBe("none");
    expect([...decls.keys()]).toEqual(["overscroll-behavior-x"]);
  });
});
