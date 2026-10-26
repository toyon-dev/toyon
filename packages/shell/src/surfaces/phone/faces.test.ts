import { describe, expect, test } from "bun:test";
import { sideOf, swipeTo } from "./faces.ts";

describe("the screen a swipe reaches", () => {
  test("right from the chat is the list", () => {
    expect(swipeTo("chat", "right", true)).toBe("home");
    expect(swipeTo("chat", "right", false)).toBe("home");
  });
  test("left from the chat is the preview while the worktree has one, else the code", () => {
    expect(swipeTo("chat", "left", true)).toBe("preview");
    expect(swipeTo("chat", "left", false)).toBe("changes");
  });
  test("the preview stands between the chat and the code", () => {
    expect(swipeTo("preview", "right", true)).toBe("chat");
    expect(swipeTo("preview", "left", true)).toBe("changes");
  });
  test("right from the code skips a preview the worktree has none of", () => {
    expect(swipeTo("changes", "right", true)).toBe("preview");
    expect(swipeTo("changes", "right", false)).toBe("chat");
  });
  test("nothing is right of the code", () => {
    expect(swipeTo("changes", "left", true)).toBe(null);
  });
  test("the list is not left by a swipe on its own", () => {
    expect(swipeTo("home", "left", true)).toBe(null);
    expect(swipeTo("home", "right", true)).toBe(null);
  });
  test("left from the list goes back to the face it just came from", () => {
    expect(swipeTo("home", "left", true, "changes")).toBe("changes");
    expect(swipeTo("home", "left", true, "preview")).toBe("preview");
    expect(swipeTo("home", "left", false, "preview")).toBe("chat");
    expect(swipeTo("home", "right", true, "chat")).toBe(null);
    expect(swipeTo("home", "left", true, "home")).toBe(null);
  });
});

describe("which side a neighbour stands on", () => {
  test("the list is left of every face, the code right of the chat", () => {
    expect(sideOf("chat", "home")).toBe("left");
    expect(sideOf("chat", "changes")).toBe("right");
    expect(sideOf("changes", "preview")).toBe("left");
  });
});
