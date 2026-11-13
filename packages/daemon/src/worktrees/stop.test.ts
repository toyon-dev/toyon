import { afterEach, describe, expect, test } from "bun:test";
import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import { STOP_TOOL } from "@toyon/shared";
import { FakeAgent } from "../../test/helpers/fakes.ts";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { StateStore } from "../core/state.ts";
import { StopTool } from "./stop.ts";

// The `stop` tool: an agent stops the turn of a worktree made from a piece of its own chat's work,
// and no other. It refuses inline, in words the agent can pass on, since "tell the person" is the
// only way on for a worktree it may not reach.

const repo = (id: string, name: string): RepoInfo => ({
  id,
  path: `/nowhere/${name}`,
  name,
  defaultBranch: "main",
  config: { run: {} },
  configFile: ".toyon/settings.json",
  needsSetup: false,
});
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
/** a worktree made from a piece of `origin`'s work */
const piece = (id: string, origin: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo =>
  row(id, { from: { kind: "worktree", ref: `toyon/${origin}`, origin: { id: origin, repoId: "r" } }, ...extra });

let cleanup = () => {};
afterEach(() => cleanup());

function make(worktrees: WorktreeInfo[], working: string[] = []) {
  const t = tmpRepo();
  cleanup = t.cleanup;
  const state = new StateStore(t.paths, { repos: [repo("r", "x"), repo("q", "y")], worktrees, sessions: {} });
  const agents = new Map<string, FakeAgent>();
  for (const w of worktrees) {
    const agent = new FakeAgent(w.id);
    if (working.includes(w.id)) agent.status = "working";
    agents.set(w.id, agent);
  }
  const tool = new StopTool({ state, agentFor: (id) => agents.get(id) });
  const refused = (id: string, args: unknown) => {
    const r = tool.call(id, args);
    expect(r.isError).toBe(true);
    return r.text;
  };
  return { tool, agents, refused };
}

describe("the stop tool", () => {
  test("says which of the chat's own pieces are running right now", () => {
    const { tool } = make(
      [row("a"), piece("b", "a", { title: "Sticky header" }), piece("c", "a"), row("d"), piece("e", "d")],
      ["b", "e"],
    );
    expect(tool.tool("a").name).toBe(STOP_TOOL);
    expect(tool.tool("a").description).toContain('Right now you can stop: toyon/b, "Sticky header".');
    expect(tool.tool("c").description).toContain("no open worktree was made from a piece of this chat's work");
    const idle = make([row("a"), piece("b", "a")]);
    expect(idle.tool.tool("a").description).toContain("none of the worktrees made from this chat's pieces is running");
  });

  test("stops the turn of a piece's worktree, by branch or title, naming who asked and why", () => {
    const { tool, agents } = make(
      [row("a", { title: "Chip search" }), piece("b", "a", { title: "Sticky header" })],
      ["b"],
    );
    const r = tool.call("a", { worktree: "sticky", reason: "  on hold until chip clicks grow " });
    expect(r).toEqual({
      text: '"Sticky header" (toyon/b) is stopping its turn. Its chat says this one stopped it and why; its worktree and files stay as they are, and the person can send it on or archive it in Toyon.',
    });
    expect(agents.get("b")?.stoppedBy).toEqual([
      {
        origin: { id: "a", repoId: "r", branch: "toyon/a", title: "Chip search" },
        reason: "on hold until chip clicks grow",
      },
    ]);
    expect(agents.get("a")?.stops).toBe(0);
    expect(tool.call("a", { worktree: "@toyon/b", reason: "again" }).isError).toBeUndefined();
  });

  test("a piece in another project is told which project the stop came from, and what waits goes next", () => {
    const { tool, agents } = make([row("a"), piece("b", "a", { repoId: "q" })], ["b"]);
    const there = agents.get("b")!;
    Object.defineProperty(there, "queueLength", { value: 2 });
    expect(tool.tool("a").description).toContain('Right now you can stop: toyon/b, "b" in y.');
    const r = tool.call("a", { worktree: "toyon/b", reason: "dropped" });
    expect(r.text).toEndWith("2 messages already waiting in that chat go next, as after any stop.");
    expect(there.stoppedBy[0]?.origin.project).toBe("x");
  });

  test("refuses, inline, what is not its to stop", () => {
    const { refused, agents } = make(
      [
        row("a"),
        piece("b", "a", { title: "Header one" }),
        piece("b2", "a", { title: "Header two" }),
        row("d", { title: "Other work" }),
        piece("e", "d"),
        piece("s", "a"),
      ],
      ["b", "d", "e", "s"],
    );
    agents.get("s")!.stopping = true;
    expect(refused("a", { worktree: "toyon/b" })).toBe("stop takes { worktree: string, reason: string }.");
    expect(refused("a", null)).toBe("stop takes { worktree: string, reason: string }.");
    expect(refused("nope", { worktree: "x", reason: "y" })).toBe("unknown worktree");
    expect(refused("a", { worktree: "toyon/b", reason: " " })).toContain("Say why in `reason`");
    expect(refused("a", { worktree: "toyon/b", reason: "x".repeat(301) })).toContain("over 300 characters");
    expect(refused("a", { worktree: " ", reason: "y" })).toBe("Name the worktree to stop, by its branch or its title.");
    expect(refused("a", { worktree: "this", reason: "y" })).toContain("That is this worktree");
    expect(refused("a", { worktree: "toyon/a", reason: "y" })).toContain("That is this worktree");
    // a sibling this chat did not make, and a piece of another chat's
    expect(refused("a", { worktree: "Other work", reason: "y" })).toBe(
      "\"Other work\" (toyon/d) was not made from a piece of this chat's work, so it is the person's to stop. Tell them, and name it.",
    );
    expect(refused("a", { worktree: "toyon/e", reason: "y" })).toContain(
      "was not made from a piece of this chat's work",
    );
    expect(refused("a", { worktree: "gone", reason: "y" })).toBe(
      'No worktree made from this chat\'s pieces is called "gone". Those open: toyon/b, "Header one"; toyon/b2, "Header two"; toyon/s, "s".',
    );
    expect(refused("e", { worktree: "gone", reason: "y" })).toBe(
      "No open worktree was made from a piece of this chat's work, so there is nothing here to stop.",
    );
    expect(refused("a", { worktree: "header", reason: "y" })).toBe(
      '"header" names more than one worktree: toyon/b, toyon/b2. Say which by its branch.',
    );
    expect(refused("a", { worktree: "toyon/b2", reason: "y" })).toBe(
      '"Header two" (toyon/b2) is not running a turn; there is nothing to stop.',
    );
    expect(refused("a", { worktree: "toyon/s", reason: "y" })).toBe('"s" (toyon/s) is stopping already.');
    expect([...agents.values()].reduce((n, agent) => n + agent.stops, 0)).toBe(0);
  });
});
