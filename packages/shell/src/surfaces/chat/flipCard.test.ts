import { describe, expect, test } from "bun:test";
import type { OwnedWorktree, ProcState, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { flipCard } from "./flipCard.ts";

// The flip's card in the chat: the sentence for where the command stands, and the chip's rows
// under it with the current one marked. Data, so the words are read here and drawn once.

const repo: Pick<RepoInfo, "config" | "tier"> = {
  config: {
    run: {
      web: "w",
      api: {
        cmd: "a",
        paths: ["server/**"],
        remotes: { stage: "https://api.stage.example.com", prod: "https://api.example.com" },
      },
      db: { cmd: "d", paths: ["db/**"] },
    },
  },
  tier: { api: { paths: ["server/**"], declared: false }, db: { paths: ["db/**"], declared: false } },
};
const info: WorktreeInfo = {
  id: "w1",
  repoId: "r",
  path: "/nowhere/w1",
  branch: "toyon/w1",
  kind: "worktree",
  proxyPort: 1,
  title: "w1",
  createdAt: 0,
};
type Live = Pick<OwnedWorktree, "worktree" | "borrowed" | "remoteBehind" | "procs">;
const row = (extra: Partial<WorktreeInfo> = {}, status: Partial<OwnedWorktree> = {}): Live =>
  ({ worktree: { ...info, ...extra }, ...status }) as Live;
const proc = (name: string, status: ProcState["status"]): ProcState => ({ name, command: "a", port: 4000, status });
const flipped = { api: { at: { by: "edit" as const, file: "server/x.ts" } } };

describe("flipCard", () => {
  test("a flip with two remotes: the sentence says it is coming up here, and the rows are the chip's with here marked", () => {
    const card = flipCard(
      "api",
      "server/x.ts",
      row({ sources: flipped }, { procs: [proc("api", "starting")] }),
      repo,
      null,
    );
    expect(card.word).toBe("runs here");
    expect(card.text).toBe(
      "api is starting here: this worktree changed server/x.ts; the page reaches main's until it answers",
    );
    expect(card.value).toBe("here");
    expect(card.rows.map((r) => [r.id, r.label, r.description, r.current])).toEqual([
      ["main", "main", "main runs it for every worktree", false],
      ["here", "here", "this worktree runs its own", true],
      ["remote:stage", "stage", "https://api.stage.example.com", false],
      ["remote:prod", "prod", "https://api.example.com", false],
    ]);
  });

  test("the sentence follows the proc: setting up before the record turns, running once it answers, and down with its reason", () => {
    // its own setup runs on the tab while the record still says main's: the flip is under way
    const preparing = flipCard("api", "server/x.ts", row({}, { procs: [proc("api", "preparing")] }), repo, null);
    expect(preparing.text).toBe(
      "api is setting up here: this worktree changed server/x.ts; the page reaches main's until it answers",
    );
    expect(preparing.word).toBe("runs here");
    expect(preparing.rows.find((r) => r.current)?.id).toBe("main");
    // the record turned and own() is about to spawn it: no row of its own yet
    const spawning = flipCard("api", "server/x.ts", row({ sources: flipped }), repo, null);
    expect(spawning.text).toBe(
      "api is starting here: this worktree changed server/x.ts; the page reaches main's until it answers",
    );
    const up = flipCard(
      "api",
      "server/x.ts",
      row({ sources: flipped }, { procs: [proc("api", "running")] }),
      repo,
      null,
    );
    expect(up.text).toBe("api runs here: this worktree changed server/x.ts");
    const down = flipCard(
      "api",
      "server/x.ts",
      row({ sources: flipped }, { procs: [proc("api", "crashed")] }),
      repo,
      null,
    );
    expect(down.text).toBe("api is crashed here: this worktree changed server/x.ts");
    // a flip that knew no one file (a lockfile batch) says what it can
    expect(flipCard("api", undefined, row({ sources: { api: { at: { by: "edit" } } } }), repo, null).text).toBe(
      "api is starting here: this worktree changed what it runs on; the page reaches main's until it answers",
    );
  });

  test("a command with no remotes has two rows", () => {
    const card = flipCard(
      "db",
      "db/schema.sql",
      row({ sources: { db: { at: { by: "edit", file: "db/schema.sql" } } } }),
      repo,
      null,
    );
    expect(card.rows.map((r) => r.id)).toEqual(["main", "here"]);
    expect(card.text).toBe(
      "db is starting here: this worktree changed db/schema.sql; the page reaches main's until it answers",
    );
  });

  test("moved on the chip, the card says where the command stands now and marks that row", () => {
    const main = flipCard("api", "server/x.ts", row({ sources: { api: { prepared: true } } }), repo, null);
    expect(main.word).toBe("ran here");
    expect(main.text).toBe(
      "api runs on main for every worktree again; it ran here after this worktree changed server/x.ts",
    );
    expect(main.value).toBe("main");
    expect(main.rows.map((r) => [r.id, r.current])).toEqual([
      ["main", true],
      ["here", false],
      ["remote:stage", false],
      ["remote:prod", false],
    ]);
    const stage = flipCard("api", "server/x.ts", row({ sources: { api: { at: { remote: "stage" } } } }), repo, null);
    expect(stage.text).toBe(
      "api points at stage for this worktree; it ran here after this worktree changed server/x.ts",
    );
    expect(stage.rows.find((r) => r.current)?.id).toBe("remote:stage");
    // main's row reads as it does on the chip: dirty main is said there too
    expect(main.rows[0]?.description).toBe("main runs it for every worktree");
    expect(flipCard("api", "server/x.ts", row(), repo, { dirty: 2 }).rows[0]?.description).toBe(
      "main runs it for every worktree; main has 2 uncommitted files; api runs on them too",
    );
  });

  test("archived, or a command the repo no longer shares, the card is history with no rows", () => {
    const gone = flipCard("api", "server/x.ts", null, null, null);
    expect(gone).toEqual({
      word: "ran here",
      text: "api ran here: this worktree changed server/x.ts",
      value: null,
      rows: [],
    });
    const dropped = flipCard("api", "server/x.ts", row({ sources: flipped }), { ...repo, tier: {} }, null);
    expect(dropped.value).toBeNull();
    expect(dropped.rows).toEqual([]);
  });
});
