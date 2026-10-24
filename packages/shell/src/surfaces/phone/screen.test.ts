import { describe, expect, test } from "bun:test";
import { type PhoneState, phoneScreen } from "./screen.ts";

const base: PhoneState = {
  incompatible: false,
  serving: true,
  machine: "laptop",
  said: false,
  onWorktree: true,
  editor: false,
  tab: "chat",
};

describe("phoneScreen", () => {
  test("a daemon speaking another protocol gets the updated card on the machine that served the page", () => {
    // the card restarts the daemon from the phone; no bar chip here offers that
    expect(phoneScreen({ ...base, incompatible: true })).toEqual({ kind: "updated", foreign: null });
  });

  test("the card names another machine, where the update is to be done", () => {
    expect(phoneScreen({ ...base, incompatible: true, serving: false })).toEqual({
      kind: "updated",
      foreign: "laptop",
    });
  });

  test("the card wins over a connection sentence: nothing further is known off that socket", () => {
    expect(phoneScreen({ ...base, incompatible: true, said: true, onWorktree: false }).kind).toBe("updated");
  });

  test("the connection sentence comes before the list and the tabs", () => {
    expect(phoneScreen({ ...base, said: true }).kind).toBe("say");
    expect(phoneScreen({ ...base, said: true, onWorktree: false }).kind).toBe("say");
  });

  test("no worktree on screen is the list", () => {
    expect(phoneScreen({ ...base, onWorktree: false }).kind).toBe("home");
  });

  test("a file open covers whichever tab is open", () => {
    expect(phoneScreen({ ...base, editor: true, tab: "changes" }).kind).toBe("editor");
  });

  test("otherwise the tab", () => {
    expect(phoneScreen({ ...base, tab: "changes" })).toEqual({ kind: "tab", tab: "changes" });
  });
});
