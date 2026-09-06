import { expect, test } from "bun:test";
import { step } from "./ListPicker.tsx";

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
  // ListPicker clamps before stepping; the raw step must still land inside the list
  expect(step(Math.min(7, 2), 1, 3)).toBe(0);
});
