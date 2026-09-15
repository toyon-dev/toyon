import { describe, expect, test } from "bun:test";
import type { UpdateState } from "@toyon/shared";
import { updateNotice } from "./updateNotice.ts";

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
