import { afterEach, describe, expect, test } from "bun:test";
import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import { OWN_TOOL } from "@toyon/shared";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { StateStore } from "../core/state.ts";
import { OwnTool } from "./own.ts";

// The `own` tool: the agent runs a shared proc here ahead of the edit that would flip it. It
// answers at once and refuses inline, since a tool that waits on a minute's start or swallows a
// refusal into a fire-and-forget teaches the agent nothing.

const repo: RepoInfo = {
  id: "r",
  path: "/nowhere",
  name: "x",
  defaultBranch: "main",
  config: {
    run: {
      web: "w",
      api: { cmd: "a", paths: ["server/**"], setup: ["uv sync"], remotes: { stage: "https://api.stage.example.com" } },
      db: { cmd: "d", from: "trunk" },
      cron: "c",
    },
  },
  configFile: ".toyon/settings.json",
  needsSetup: false,
  tier: { api: { paths: ["server/**"] }, db: { paths: [] } },
};
const row = (id: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  id,
  repoId: "r",
  path: `/nowhere/${id}`,
  branch: `toyon/${id}`,
  kind: "worktree",
  proxyPort: 1,
  title: id,
  createdAt: 0,
  ...extra,
});

let cleanup = () => {};
afterEach(() => cleanup());

function make(worktrees: WorktreeInfo[], repos: RepoInfo[] = [repo]) {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const state = new StateStore(t.paths, { repos, worktrees, sessions: {} });
  const owned: Array<[string, string[]]> = [];
  let release = () => {};
  const tool = new OwnTool({
    state,
    own: (id, names) => {
      owned.push([id, names]);
      // never resolves until the test says: the tool must not wait on it
      return new Promise<void>((r) => {
        release = r;
      });
    },
  });
  return { tool, owned, state, release: () => release() };
}

describe("the own tool", () => {
  test("describes what the worktree reaches on main right now", () => {
    const { tool } = make([
      row("a"),
      row("b", { sources: { api: { at: { by: "hand" } }, db: { at: { by: "hand" } } } }),
    ]);
    expect(tool.tool("a").name).toBe(OWN_TOOL);
    expect(tool.tool("a").description).toContain("Right now this worktree reaches api, db on main.");
    expect(tool.tool("b").description).toContain("Right now nothing here runs on main.");
  });

  test("takes the named procs, or every borrowed one, and answers before the start is through", async () => {
    const { tool, owned, release } = make([row("a")]);
    const r = tool.call("a", { names: ["api"] });
    expect(r).toEqual({ text: "api starts here now; API_URL does not change. api runs its own setup first." });
    expect(owned).toEqual([["a", ["api"]]]);
    const all = tool.call("a", {});
    expect(all).toEqual({
      text: "api, db start here now; API_URL and DB_URL do not change. api runs its own setup first.",
    });
    expect(owned[1]).toEqual(["a", ["api", "db"]]);
    release();
    await Bun.sleep(0);
  });

  test("a prepared proc runs no setup again, and the reply says nothing of one", () => {
    const { tool } = make([row("a", { sources: { api: { prepared: true } } })]);
    expect(tool.call("a", { names: ["api"] })).toEqual({ text: "api starts here now; API_URL does not change." });
  });

  test("refuses, inline, what it cannot do", () => {
    const main = row("m", { kind: "main" });
    const { tool, owned } = make([
      row("a"),
      main,
      row("p", { mode: "plan" }),
      row("s", { sources: { api: { at: { remote: "stage" } } } }),
      row("o", { sources: { api: { at: { by: "hand" } }, db: { at: { by: "hand" } } } }),
    ]);
    const refused = (id: string, args: unknown) => {
      const r = tool.call(id, args);
      expect(r.isError).toBe(true);
      return r.text;
    };
    expect(refused("a", { names: "api" })).toBe("own takes { names?: string[] }.");
    expect(refused("a", { names: [1] })).toBe("own takes { names?: string[] }.");
    expect(refused("nope", {})).toBe("unknown worktree");
    expect(refused("m", {})).toContain("main checkout");
    expect(refused("p", { names: ["api"] })).toBe(
      "This worktree is in plan mode; nothing runs until the plan is approved. Say in the plan that api will run here.",
    );
    expect(refused("a", { names: ["nope"] })).toBe(
      'No command "nope" in .toyon/settings.json. The commands this worktree reaches on main: api, db.',
    );
    expect(refused("s", { names: ["api"] })).toContain(
      "The page here points api at stage (https://api.stage.example.com). Toyon does not move it for you",
    );
    expect(refused("o", { names: ["api"] })).toBe("api already runs here.");
    expect(refused("o", {})).toBe("Nothing here runs on main: every command runs in this worktree already.");
    // a command every copy runs is not main's to give
    expect(refused("a", { names: ["cron"] })).toBe("cron already runs here.");
    expect(owned).toEqual([]);
  });

  test("a project with nothing shared says so", () => {
    const flat: RepoInfo = { ...repo, config: { run: { web: "w", cron: "c" } }, tier: {} };
    const { tool } = make([row("a")], [flat]);
    expect(tool.call("a", {})).toEqual({
      text: "Nothing in this project is shared: every command runs in this worktree already.",
      isError: true,
    });
  });
});
