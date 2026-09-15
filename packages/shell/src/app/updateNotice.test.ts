import { describe, expect, test } from "bun:test";
import type { UpdateState } from "@toyon/shared";
import { updateNotice } from "./updateNotice.ts";

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  running: "0.2.0",
  installed: null,
  restarting: null,
  ...over,
});

describe("updateNotice", () => {
  test("nothing to say while the installed Toyon is the one running", () => {
    expect(updateNotice(null)).toBeNull();
    expect(updateNotice(state())).toBeNull();
  });

  test("an install under the running daemon offers the restart and names both versions", () => {
    expect(updateNotice(state({ installed: "0.3.0" }))).toEqual({
      word: "restart to update",
      text: "Toyon 0.3.0 is installed; 0.2.0 is running",
      busy: false,
    });
  });

  test("a restart waiting on a reply says so, and the tip names the chat", () => {
    const n = updateNotice(state({ installed: "0.3.0", restarting: ["fix login"] }));
    expect(n).toMatchObject({ word: "restarts after a reply", busy: true });
    expect(n?.text).toBe("Toyon restarts once fix login finishes");
  });

  test("several chats are counted in the word and listed in the tip", () => {
    const n = updateNotice(state({ restarting: ["fix login", "docs"] }));
    expect(n?.word).toBe("restarts after 2 replies");
    expect(n?.text).toBe("Toyon restarts once fix login, docs finish");
  });

  test("a restart under way takes no press", () => {
    expect(updateNotice(state({ installed: "0.3.0", restarting: [] }))).toMatchObject({
      word: "restarting",
      busy: true,
    });
  });
});
