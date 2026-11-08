import { describe, expect, test } from "bun:test";
import type { OwnedWorktree, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { sourceOf, sourceOptions, sourcePick } from "./sourceChip.ts";

// The chip under the box for a shared command: where it runs for this worktree's page, what each
// row would do, and the frames a pick sends. Data, so the words are read here and drawn once.

const repo: Pick<RepoInfo, "config"> = {
  config: {
    run: {
      web: "w",
      api: { cmd: "a", paths: ["server/**"], remotes: { stage: "https://api.stage.example.com" } },
      db: { cmd: "d", paths: [] },
    },
  },
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
const row = (extra: Partial<WorktreeInfo> = {}, status: Partial<OwnedWorktree> = {}) =>
  ({ worktree: { ...info, ...extra }, ...status }) as Pick<
    OwnedWorktree,
    "worktree" | "borrowed" | "remoteBehind" | "procs"
  >;

describe("sourceOf", () => {
  test("a remote the page points at wins, then the worktree's own, else main's", () => {
    expect(sourceOf("api", row())).toBe("main");
    expect(sourceOf("api", row({ sources: { api: { at: { by: "edit", file: "server/x.js" } } } }))).toBe("here");
    expect(sourceOf("api", row({ sources: { api: { at: { remote: "stage" } } } }))).toBe("remote:stage");
    expect(sourceOf("db", row({ sources: { api: { at: { remote: "stage" } } } }))).toBe("main");
  });
});

describe("sourceOptions", () => {
  test("main first, then here, then each remote with its URL; a command with no remotes has two rows", () => {
    const api = sourceOptions("api", row(), repo, null);
    expect(api.value).toBe("main");
    expect(api.held).toBe(false);
    expect(api.options.map((o) => [o.id, o.label, o.chip, o.description])).toEqual([
      ["main", "main", "api · main", "main runs it for every worktree"],
      ["here", "here", "api · here", "this worktree runs its own"],
      ["remote:stage", "stage", "api · stage", "https://api.stage.example.com"],
    ]);
    expect(api.hint).toBe("api runs on main for every worktree. Click to change");
    expect(sourceOptions("db", row(), repo, null).options.map((o) => o.id)).toEqual(["main", "here"]);
  });

  test("main's row says when main is dirty and when main's copy is down", () => {
    const dirty = sourceOptions("api", row(), repo, { dirty: 3 });
    expect(dirty.options[0]?.description).toBe(
      "main runs it for every worktree; main has 3 uncommitted files; api runs on them too",
    );
    expect(dirty.hint).toBe(
      "api runs on main for every worktree; main has 3 uncommitted files; api runs on them too. Click to change",
    );
    const one = sourceOptions("api", row(), repo, { dirty: 1 });
    expect(one.options[0]?.description).toContain("main has 1 uncommitted file;");
    const down = sourceOptions("api", row({}, { borrowed: [{ name: "api", status: "crashed" }] }), repo, { dirty: 0 });
    expect(down.options[0]?.description).toBe("main runs it for every worktree; main's api is crashed");
    const cold = sourceOptions("api", row({}, { borrowed: [{ name: "api", status: "cold" }] }), repo, null);
    expect(cold.options[0]?.description).toBe("main runs it for every worktree");
  });

  test("while the command's own setup runs here, the chip stays main's and both rows say it is setting up", () => {
    const preparing = sourceOptions(
      "api",
      row(
        {},
        {
          borrowed: [{ name: "api", status: "running" }],
          procs: [{ name: "api", command: "a", port: 4000, status: "preparing", detail: "setup: uv sync" }],
        },
      ),
      repo,
      { dirty: 0 },
    );
    expect(preparing.value).toBe("main");
    expect(preparing.hint).toBe("api runs on main for every worktree; its own is setting up here. Click to change");
    expect(preparing.options[0]?.description).toBe(
      "main runs it for every worktree; api is setting up here and takes over once it answers",
    );
    expect(preparing.options[1]?.description).toBe("this worktree is setting up its own");
    // spawned, the rows read as before
    const starting = sourceOptions(
      "api",
      row({}, { procs: [{ name: "api", command: "a", port: 4000, status: "starting" }] }),
      repo,
      { dirty: 0 },
    );
    expect(starting.options[0]?.description).toBe("main runs it for every worktree");
    expect(starting.options[1]?.description).toBe("this worktree runs its own");
  });

  test("here and a remote read as what they are", () => {
    expect(sourceOptions("api", row({ sources: { api: { at: { by: "hand" } } } }), repo, null).hint).toBe(
      "api runs here: this worktree's own. Click to change",
    );
    const pointed = sourceOptions("api", row({ sources: { api: { at: { remote: "stage" } } } }), repo, null);
    expect(pointed.value).toBe("remote:stage");
    expect(pointed.hint).toBe("api points at stage for this worktree. Click to change");
  });

  test("a pointed command whose files changed here is held, with here as the first row", () => {
    const held = sourceOptions(
      "api",
      row({ sources: { api: { at: { remote: "stage" } } } }, { remoteBehind: ["api"] }),
      repo,
      null,
    );
    expect(held.held).toBe(true);
    expect(held.options.map((o) => o.id)).toEqual(["here", "main", "remote:stage"]);
    expect(held.hint).toBe("api edits here are not what the page is talking to; pick here to run them");
  });
});

describe("sourcePick", () => {
  test("each move is one frame naming the source, and only handing a proc back to main asks first", () => {
    const frame = (source: "main" | "here" | { remote: string }) =>
      ({ t: "set-proc-source", worktreeId: "w1", name: "api", source }) as const;
    expect(sourcePick("api", "main", "main", "w1")).toBeNull();
    expect(sourcePick("api", "main", "here", "w1")).toEqual({ msg: frame("here") });
    const back = sourcePick("api", "here", "main", "w1")!;
    expect(back.msg).toEqual(frame("main"));
    expect(back.confirm).toBe(
      "Stop this worktree's own api and use main's?\n\nWhat they hold that main's do not (a database of their own) is not carried over.",
    );
    expect(sourcePick("api", "main", "remote:stage", "w1")).toEqual({ msg: frame({ remote: "stage" }) });
    expect(sourcePick("api", "here", "remote:stage", "w1")).toEqual({ msg: frame({ remote: "stage" }) });
    // back from a remote drops nothing the worktree holds, so no question
    expect(sourcePick("api", "remote:stage", "main", "w1")).toEqual({ msg: frame("main") });
    expect(sourcePick("api", "remote:stage", "here", "w1")).toEqual({ msg: frame("here") });
  });
});
