import { afterEach, describe, expect, test } from "bun:test";
import type { ShellToBridgeMsg } from "@toyon/shared";
import type { Action } from "../state/store.ts";
import { previewBus, togglePick } from "./previewBus.ts";

const idle = previewBus.post;
afterEach(() => {
  previewBus.post = idle;
});

function recorder() {
  const posted: ShellToBridgeMsg[] = [];
  const acts: Action[] = [];
  previewBus.post = (_id, msg) => {
    posted.push(msg);
  };
  return { posted, acts, dispatch: (a: Action) => void acts.push(a) };
}

describe("togglePick", () => {
  test("from rest a chord arms its own verb", () => {
    const r = recorder();
    togglePick("a", false, r.dispatch, "code");
    expect(r.posted).toEqual([{ type: "pick-start", verb: "code" }]);
    expect(r.acts).toEqual([{ a: "set-picking", v: "code" }]);
  });
  test("the verb already armed disarms", () => {
    const r = recorder();
    togglePick("a", "chat", r.dispatch, "chat");
    expect(r.posted).toEqual([{ type: "pick-cancel" }]);
    expect(r.acts).toEqual([{ a: "set-picking", v: false }]);
  });
  // ⌘I pressed while ⌘E's picker is up: the bridge trades the verb in place rather than the shell
  // cancelling and re-arming, which would drop the box under a pointer that has not moved
  test("the other verb swaps in place", () => {
    const r = recorder();
    togglePick("a", "chat", r.dispatch, "code");
    expect(r.posted).toEqual([{ type: "pick-start", verb: "code" }]);
    expect(r.acts).toEqual([{ a: "set-picking", v: "code" }]);
  });
});
