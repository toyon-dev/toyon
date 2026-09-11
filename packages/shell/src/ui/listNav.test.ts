import { expect, test } from "bun:test";
import { ghostOf, ghostParts, jumpTo, step, stepFrom } from "./listNav.ts";

test("a letter jumps to the next row starting with it, wrapping, and repeats walk the matches", () => {
  const rows = ["take over", "open a shell here", "reveal in Finder", "copy path", "Remove…"];
  expect(jumpTo(rows, -1, "t")).toBe(0);
  expect(jumpTo(rows, -1, "r")).toBe(2);
  expect(jumpTo(rows, 2, "r")).toBe(4);
  expect(jumpTo(rows, 4, "r")).toBe(2);
  expect(jumpTo(rows, 0, "T")).toBe(0);
  expect(jumpTo(rows, 1, "z")).toBe(-1);
  expect(jumpTo([], -1, "a")).toBe(-1);
});

test("↑↓ wrap at both ends", () => {
  expect(step(0, 1, 3)).toBe(1);
  expect(step(2, 1, 3)).toBe(0);
  expect(step(0, -1, 3)).toBe(2);
});
test("an empty list pins the highlight to 0", () => {
  expect(step(0, 1, 0)).toBe(0);
  expect(step(5, -1, 0)).toBe(0);
});
test("stepping from a stale index (results shrank) stays in range", () => {
  // useListNav clamps before stepping; the raw step must still land inside the list
  expect(step(Math.min(7, 2), 1, 3)).toBe(0);
});

test("from nothing highlighted, down lands on the first row and up on the last", () => {
  expect(stepFrom(-1, 1, 3)).toBe(0);
  expect(stepFrom(-1, -1, 3)).toBe(2);
  expect(stepFrom(-1, 1, 0)).toBe(-1);
  // from a row it is the ordinary wrap
  expect(stepFrom(2, 1, 3)).toBe(0);
  expect(stepFrom(0, 1, 0)).toBe(0);
});

test("the ghost is only the tail past what was typed, matched case-insensitively", () => {
  expect(ghostOf("toyon", "toy")).toBe("on");
  expect(ghostOf("Toyon", "toy")).toBe("on");
  expect(ghostOf("toy", "toy")).toBeNull();
  expect(ghostOf("other", "toy")).toBeNull();
  expect(ghostOf(null, "toy")).toBeNull();
});

test("a plain completion is taken whole by tab", () => {
  expect(ghostParts("/pricing", "/pr")).toEqual({ text: "icing", accept: "icing", params: [] });
  expect(ghostParts("/pricing", "/pricing")).toBeNull();
  expect(ghostParts(null, "/pr")).toBeNull();
});

test("a completion can show a placeholder that tab does not take", () => {
  // "/users/id", with "id" a placeholder and only "/users/" accepted
  const users = { show: "/users/id", accept: "/users/", params: [[7, 9]] as Array<[number, number]> };
  expect(ghostParts(users, "/us")).toEqual({ text: "ers/id", accept: "ers/", params: [[4, 6]] });
  // with the literal part typed, only the placeholder is left, and tab has nothing to take
  expect(ghostParts(users, "/users/")).toEqual({ text: "id", accept: null, params: [[0, 2]] });
  // a placeholder already typed past is not drawn
  const two = {
    show: "/o/org/r/repo",
    accept: "/o/org/r/",
    params: [[3, 6] as [number, number], [9, 13] as [number, number]],
  };
  expect(ghostParts(two, "/o/acme")).toBeNull();
  expect(ghostParts(two, "/o/org/")?.params).toEqual([[2, 6]]);
});
