import { describe, expect, test } from "bun:test";
import type { UpdateState } from "@toyon/shared";
import { restartHeldLine, restartRows, restartSeen, updateNotice } from "./updateNotice.ts";

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  running: "0.2.0",
  latest: null,
  installed: null,
  method: "npm",
  installing: false,
  failed: null,
  restarting: null,
  ...over,
});

describe("updateNotice", () => {
  test("says nothing while updating works, like a site that deploys", () => {
    expect(updateNotice(null)).toBeNull();
    expect(updateNotice(state({ latest: "0.3.0" }))).toBeNull();
    expect(updateNotice(state({ installed: "0.3.0" }))).toBeNull();
    expect(updateNotice(state({ latest: "0.3.0", installing: true }))).toBeNull();
    // under way: the tab reloads a moment later
    expect(updateNotice(state({ installed: "0.3.0", restarting: [] }))).toBeNull();
  });

  test("a failed install says why and what to run, and a press tries again", () => {
    const n = updateNotice(
      state({
        latest: "0.3.0",
        failed: { version: "0.3.0", line: "npm error code EACCES.", command: "npm install -g toyon@0.3.0" },
      }),
    );
    expect(n).toMatchObject({ word: "update failed", retry: true, busy: false });
    expect(n?.text).toBe(
      "Installing Toyon 0.3.0 stopped: npm error code EACCES. To update by hand, run npm install -g toyon@0.3.0",
    );
  });

  test("a pressed restart waiting on a reply says so, and the tip names the chat", () => {
    const n = updateNotice(state({ restarting: ["fix login"] }));
    expect(n).toMatchObject({ word: "restarts after a reply", retry: false, busy: true });
    expect(n?.text).toBe("Toyon restarts once fix login finishes");
  });

  test("several chats are counted in the word and listed in the tip", () => {
    const n = updateNotice(state({ restarting: ["fix login", "docs"] }));
    expect(n?.word).toBe("restarts after 2 replies");
    expect(n?.text).toBe("Toyon restarts once fix login, docs finish");
  });
});

describe("the card a held restart shows", () => {
  test("a chat met holding the restart keeps its place once it has finished", () => {
    const seen = restartSeen(restartSeen([], ["fix login", "docs"]), ["docs"]);
    expect(seen).toEqual(["fix login", "docs"]);
    expect(restartRows(seen, ["docs"], [])).toEqual([
      { name: "fix login", dot: "idle", note: "finished" },
      { name: "docs", dot: "working", note: null },
    ]);
  });

  test("a chat that starts replying during the wait joins the end", () => {
    expect(restartSeen(["docs"], ["docs", "new one"])).toEqual(["docs", "new one"]);
  });

  test("a chat stopped on a question is listed last and holds nothing", () => {
    expect(restartRows(["docs"], ["docs"], ["pick a colour"])).toEqual([
      { name: "docs", dot: "working", note: null },
      { name: "pick a colour", dot: "waiting", note: "asking you" },
    ]);
  });

  test("two chats sharing a title: one still replying marks one row, not both", () => {
    expect(restartRows(["docs", "docs"], ["docs"], []).map((r) => r.dot)).toEqual(["working", "idle"]);
  });

  test("the sentence counts what is left of what was met", () => {
    expect(restartHeldLine(1, 1)).toBe(
      "Toyon restarts once this chat finishes its reply, and this page reloads when it is back. Restarting now stops it mid-reply.",
    );
    expect(restartHeldLine(3, 3)).toStartWith("Toyon restarts once these 3 chats finish their replies,");
    expect(restartHeldLine(1, 5)).toStartWith("4 of 5 chats have finished; Toyon restarts after the last one,");
    expect(restartHeldLine(2, 5)).toStartWith("3 of 5 chats have finished; Toyon restarts after the other 2,");
    expect(restartHeldLine(2, 5)).toEndWith("Restarting now stops them mid-reply.");
  });
});
