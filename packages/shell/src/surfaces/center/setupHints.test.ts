import { describe, expect, test } from "bun:test";
import { tierHint } from "./setupHints.ts";

describe("tierHint", () => {
  const repo = {
    config: {
      run: { web: "vite", api: { cmd: "node server/index.js" }, cron: "node cron.js", db: { cmd: "d", paths: [] } },
    },
    tier: { api: { paths: ["server/**"], declared: false }, db: { paths: [], declared: true } },
  };
  test("says what the saved file comes to, and nothing for a row the file does not have yet", () => {
    expect(tierHint("api", "node server/index.js", "auto", repo)).toBe(
      "main runs it; a worktree that changes server/** runs its own",
    );
    expect(tierHint("db", "d", "auto", repo)).toBe("main runs it for every worktree; no change here flips it");
    expect(tierHint("cron", "node cron.js", "auto", repo)).toBe(
      "every worktree runs its own: the command names nothing Toyon can watch",
    );
    expect(tierHint("cron", "node cron.js", "trunk", repo)).toBe(
      "main runs it; a worktree that changes anything outside the page's folders runs its own",
    );
    // the chip says it
    expect(tierHint("api", "node server/index.js", "copy", repo)).toBeNull();
    // edited or new: no tier to read yet
    expect(tierHint("api", "node server/other.js", "auto", repo)).toBeNull();
    expect(tierHint("worker", "node worker.js", "auto", repo)).toBeNull();
  });
});
