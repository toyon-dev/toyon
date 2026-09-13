import { describe, expect, test } from "bun:test";
import { takeGrant } from "./remote.ts";

// The grant rides in the browser's Cookie header next to the app's own cookies. It is checked, then
// taken off, so the dev server behind a preview sees exactly what the app set and nothing of toyon's.

describe("takeGrant", () => {
  const grant = "ab".repeat(32);

  test("finds the grant among the app's cookies and leaves theirs in order", () => {
    expect(takeGrant(`a=1; toyon_preview=${grant}; b=2`, grant)).toEqual({ ok: true, rest: "a=1; b=2" });
  });
  test("a header holding only the grant leaves nothing to forward", () => {
    expect(takeGrant(`toyon_preview=${grant}`, grant)).toEqual({ ok: true, rest: null });
  });
  test("a wrong or truncated grant fails and is still taken off", () => {
    expect(takeGrant(`toyon_preview=nope; a=1`, grant)).toEqual({ ok: false, rest: "a=1" });
    expect(takeGrant(`toyon_preview=${grant.slice(1)}`, grant)).toEqual({ ok: false, rest: null });
  });
  test("an app cookie whose name only starts the same is the app's", () => {
    expect(takeGrant(`toyon_preview_x=${grant}`, grant)).toEqual({ ok: false, rest: `toyon_preview_x=${grant}` });
  });
  test("no header, or an empty one", () => {
    expect(takeGrant(null, grant)).toEqual({ ok: false, rest: null });
    expect(takeGrant(" ; ", grant)).toEqual({ ok: false, rest: null });
  });
  test("a duplicate set by the app beside the real one does not lock the browser out", () => {
    expect(takeGrant(`toyon_preview=x; toyon_preview=${grant}`, grant)).toEqual({ ok: true, rest: null });
  });
});
