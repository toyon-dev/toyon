import { describe, expect, test } from "bun:test";
import { MANAGED_NONE, type OwnedWorktree, type RepoInfo, type Theme } from "@toyon/shared";
import { defaultLayout } from "../../state/store.ts";
import { buildCommands, type Command, type CommandState, commandHits, filterCommands } from "./commands.ts";

describe("buildCommands", () => {
  const repo = {
    id: "r",
    path: "/r",
    name: "r",
    defaultBranch: "main",
    config: { run: { web: "vite" } },
    configFile: ".toyon/settings.json",
    needsSetup: false,
  } as RepoInfo;
  const wt = {
    id: "w1",
    repoId: "r",
    name: "feature",
    branch: "feature",
    path: "/r/wt/feature",
    worktree: {
      id: "w1",
      repoId: "r",
      title: "feature",
      branch: "toyon/feature",
      path: "/r/wt/feature",
      kind: "worktree",
      proxyPort: 1,
      createdAt: 0,
    },
    procs: [],
    agent: "idle",
    dirty: 0,
    ahead: 0,
    behind: 0,
  } as unknown as OwnedWorktree;
  const state = {
    picking: null,
    layout: { ...defaultLayout, changes: true },
    chatSide: "left",
    railOpen: true,
    themePrefs: { mode: "system", dark: "t", light: "t" },
    themes: [{ id: "t", name: "Night", kind: "dark" } as Theme],
    systemDark: true,
    rows: [wt],
    visible: [wt],
    activeId: "w1",
    activeRepoId: "r",
    repos: [repo],
    agents: [],
    defaultAgent: "claude",
    shipping: {},
    remote: null,
    managed: MANAGED_NONE,
    frame: "desk",
    hostname: "localhost",
  } as unknown as CommandState;

  // the rows are keyed by id, so an id twice leaves a stale row behind when the list changes
  test("gives every command its own id, though the app and a worktree both have a terminal", () => {
    const ids = buildCommands(state, () => {}, null, wt, repo).map((c) => c.id);
    expect(ids).toContain("terminal");
    expect(ids).toContain("wt:terminal");
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
  test("a project with nothing to run offers none of a page's verbs, and no chat panel to toggle", () => {
    const pageVerbs = ["pick", "inspect", "reload", "chat", "design", "zen"];
    const web = buildCommands(state, () => {}, null, wt, repo).map((c) => c.id);
    for (const id of pageVerbs) expect(web).toContain(id);
    const bare = { ...repo, config: { run: {} } } as RepoInfo;
    const ids = buildCommands({ ...state, repos: [bare] }, () => {}, null, wt, bare).map((c) => c.id);
    for (const id of pageVerbs) expect(ids).not.toContain(id);
    expect(ids).toContain("terminal");
  });
  test("a machine with a public name offers to add it to toyon.cloud, by name and without the token", () => {
    expect(buildCommands(state, () => {}, null, wt, repo).map((c) => c.id)).not.toContain("toyon-cloud");
    const remote = { host: "my-toyon.fly.dev", previews: "https://my-toyon.fly.dev:{port}", front: "edge" as const };
    const opened: string[] = [];
    const g = globalThis as any;
    const saved = g.window;
    g.window = { open: (url: string) => opened.push(url) };
    try {
      const add = buildCommands({ ...state, remote }, () => {}, null, wt, repo).find((c) => c.id === "toyon-cloud");
      expect(add?.label).toBe("add to toyon.cloud");
      add?.run();
      expect(opened).toEqual(["https://toyon.cloud/#add=https%3A%2F%2Fmy-toyon.fly.dev"]);
    } finally {
      g.window = saved;
    }
  });
  test("a desk with a public name offers a code for a phone; a phone and a local machine do not", () => {
    const remote = {
      host: "box.tailnet.ts.net",
      previews: "https://box.tailnet.ts.net:{port}",
      front: "local" as const,
    };
    const ids = (s: typeof state) => buildCommands(s, () => {}, null, wt, repo).map((c) => c.id);
    expect(ids(state)).not.toContain("pair");
    expect(ids({ ...state, remote, frame: "phone" })).not.toContain("pair");
    const actions: unknown[] = [];
    const pair = buildCommands({ ...state, remote }, (a) => actions.push(a), null, wt, repo).find(
      (c) => c.id === "pair",
    );
    expect(pair?.label).toBe("open on your phone");
    pair?.run();
    expect(actions).toEqual([{ a: "open", overlay: { kind: "pair" } }]);
  });
  test("the handoff stays off the palette with one project open, and is on it with two", () => {
    const ids = (s: CommandState) => buildCommands(s, () => {}, null, wt, repo).map((c) => c.id);
    expect(ids(state)).not.toContain("wt:handoff");
    const other = { ...repo, id: "r2", name: "acp", path: "/acp" } as RepoInfo;
    expect(ids({ ...state, repos: [repo, other] })).toContain("wt:handoff");
  });
  test("a guest's switch row names its project, since the rail's mark does", () => {
    const other = { ...repo, id: "r2", name: "acp", path: "/acp" } as RepoInfo;
    const guest = {
      ...wt,
      id: "g",
      repoId: "r2",
      name: "bump the pin",
      worktree: {
        ...wt.worktree,
        id: "g",
        repoId: "r2",
        title: "bump the pin",
        from: { kind: "worktree", ref: "toyon/feature", origin: { id: "w1", repoId: "r" } },
      },
    } as unknown as OwnedWorktree;
    const s = { ...state, repos: [repo, other], rows: [wt, guest], visible: [wt, guest] };
    const labels = buildCommands(s, () => {}, null, wt, repo).map((c) => c.label);
    expect(labels).toContain("switch to bump the pin in acp");
    // the same row on its own project's rail is a plain switch
    const own = { ...s, activeId: "g", activeRepoId: "r2", visible: [guest] };
    expect(buildCommands(own, () => {}, null, wt, repo).map((c) => c.label)).toContain("switch to bump the pin");
  });
  // the settings menu shows the theme rows as a group under a rule; the palette has no rules, so
  // the group is a word in front of each, and typing that word lists them all
  test("lists the whole theme cluster under its word", () => {
    const cmds = buildCommands(state, () => {}, null, wt, repo);
    const hits = filterCommands(cmds, "theme").map((c) => c.label);
    expect(hits.sort()).toEqual([
      "theme: dark slot override…",
      "theme: import a VS Code theme…",
      "theme: light or dark…",
      "theme: light slot override…",
      "theme: rescan editor themes",
      "theme…",
    ]);
  });

  describe("other machines in the palette", () => {
    test("their projects are rows naming the machine, and the machine can be forgotten", () => {
      const calls: string[] = [];
      const cross = {
        machines: [
          { origin: "https://work.tail1234.ts.net", name: "work", repos: [{ ...repo, id: "r2", name: "site" }] },
        ],
        switchTo: (origin: string, repoId: string) => calls.push(`switch ${origin} ${repoId}`),
        forget: (origin: string) => calls.push(`forget ${origin}`),
      };
      const cmds = buildCommands(state, () => {}, null, wt, repo, cross);
      const go = cmds.find((c) => c.id === "machine:https://work.tail1234.ts.net:r2");
      expect(go?.label).toBe("switch to project site on work");
      go?.run();
      const forget = cmds.find((c) => c.id === "forget-machine:https://work.tail1234.ts.net");
      expect(forget?.label).toBe("forget work");
      forget?.run();
      expect(calls).toEqual(["switch https://work.tail1234.ts.net r2", "forget https://work.tail1234.ts.net"]);
      expect(cmds.map((c) => c.id)).toContain("add-machine");
    });
    test("with no other machine the palette is what it was", () => {
      const ids = buildCommands(state, () => {}, null, wt, repo).map((c) => c.id);
      expect(ids.some((id) => id.startsWith("machine:") || id.startsWith("forget-machine:"))).toBe(false);
    });
  });
});

// The palette matcher's one rule: a character may only skip ahead to the start of a word, so a
// typo can't scavenge a match out of a long label. Everything else (ranking, hit positions for
// highlighting) follows from it.

const cmd = (label: string): Command => ({ id: label, label, run: () => {} });

describe("commandHits", () => {
  test("consecutive characters match in place", () => {
    expect(commandHits("Toggle changes", "tog")).toEqual([0, 1, 2]);
  });
  test("a skip lands only on a word start", () => {
    expect(commandHits("Toggle changes", "tc")).toEqual([0, 7]);
    // "e" occurs mid-word in "Toggle" but not at any word start after position 0
    expect(commandHits("Toggle changes", "te")).toBeNull();
  });
  test("punctuation opens a word", () => {
    expect(commandHits("light/dark mode…", "ld")).toEqual([0, 6]);
    expect(commandHits("switch to: main", "sm")).toEqual([0, 11]);
  });
  test("a typed space jumps to the next gap", () => {
    expect(commandHits("Toggle changes", "t c")).toEqual([0, 6, 7]);
  });
  test("case-insensitive", () => {
    expect(commandHits("Ship PR", "SP")).toEqual([0, 5]);
  });
  test("no match is null, not an empty list", () => {
    expect(commandHits("Ship PR", "x")).toBeNull();
  });
});

describe("filterCommands", () => {
  const cmds = [
    cmd("Toggle changes"),
    cmd("Toggle chat"),
    cmd("switch to you-ve-hit-your-session-limit"),
    cmd("theme…"),
  ];
  test("empty query keeps the order", () => {
    expect(filterCommands(cmds, "  ")).toBe(cmds);
  });
  test("the typo can't scavenge a match", () => {
    expect(filterCommands(cmds, "theem").map((c) => c.label)).toEqual([]);
  });
  test("exact prefix beats a scattered match, shorter label wins a tie", () => {
    expect(filterCommands(cmds, "toggle ch").map((c) => c.label)).toEqual(["Toggle chat", "Toggle changes"]);
  });
  test("word initials find the long label", () => {
    expect(filterCommands(cmds, "sy").map((c) => c.label)).toEqual(["switch to you-ve-hit-your-session-limit"]);
  });
});
