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
  test("nothing to say while Toyon is current", () => {
    expect(updateNotice(null)).toBeNull();
    expect(updateNotice(state())).toBeNull();
  });

  test("a newer version out offers the update and names both versions", () => {
    expect(updateNotice(state({ latest: "0.3.0" }))).toEqual({
      word: "update to 0.3.0",
      text: "Toyon 0.3.0 is out; 0.2.0 is running",
      action: "update",
      busy: false,
    });
  });

  test("an npx copy is offered the command to copy, since nothing installs it", () => {
    expect(updateNotice(state({ latest: "0.3.0", method: "npx" }))).toMatchObject({
      word: "0.3.0 is out",
      action: "copy",
      copy: "npx toyon@0.3.0",
    });
  });

  test("an install under the running daemon offers the restart", () => {
    expect(updateNotice(state({ installed: "0.3.0" }))).toEqual({
      word: "restart to update",
      text: "Toyon 0.3.0 is installed; 0.2.0 is running",
      action: "restart",
      busy: false,
    });
    // the newest is what was installed: nothing left to install, only the restart
    expect(updateNotice(state({ installed: "0.3.0", latest: "0.3.0" }))?.action).toBe("restart");
  });

  test("an install under way takes no press", () => {
    expect(updateNotice(state({ latest: "0.3.0", installing: true }))).toMatchObject({
      word: "updating",
      text: "Installing Toyon 0.3.0",
      busy: true,
    });
  });

  test("a failed install says why and what to run, and a press tries again", () => {
    const n = updateNotice(
      state({
        latest: "0.3.0",
        failed: { version: "0.3.0", line: "npm error code EACCES.", command: "npm install -g toyon@0.3.0" },
      }),
    );
    expect(n).toMatchObject({ word: "update failed", action: "update", busy: false });
    expect(n?.text).toBe(
      "Installing Toyon 0.3.0 stopped: npm error code EACCES. To update by hand, run npm install -g toyon@0.3.0",
    );
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
