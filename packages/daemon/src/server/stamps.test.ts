import { describe, expect, test } from "bun:test";
import { type HelloFull, MANAGED_NONE, PROTOCOL_VERSION, type Theme, type WorktreeStatus } from "@toyon/shared";
import { shapeHello, stampOf, stampsOf, visitsStamp } from "./stamps.ts";

const row = (id: string, agent: WorktreeStatus["agent"] = "idle"): WorktreeStatus => ({
  id,
  repoId: "r",
  path: `/w/${id}`,
  name: id,
  branch: id,
  worktree: { id, repoId: "r", kind: "worktree", path: `/w/${id}`, branch: id, proxyPort: 1, title: id, createdAt: 0 },
  procs: [],
  agent,
  login: false,
});

const theme = { id: "t1", name: "t1" } as unknown as Theme;

const hello = (rows: WorktreeStatus[], themes: Theme[] = [theme]): HelloFull => {
  const parts = { rows, trunks: {}, repos: [], visits: {}, themes };
  return {
    t: "hello",
    version: "0",
    machine: "box",
    install: "npm",
    registry: null,
    protocol: PROTOCOL_VERSION,
    ...parts,
    stamps: stampsOf(parts),
    themePrefs: { mode: "dark", dark: "x", light: "x" },
    agents: [],
    defaultAgent: "claude",
    agentChosen: true,
    home: "/h",
    folderDialog: false,
    keepAwake: null,
    remote: null,
    letIn: false,
    knocks: [],
    tailscale: null,
    machines: [],
    gitIdentity: true,
    pending: [],
    self: null,
    update: null,
    globalInstall: null,
    drafts: {},
    attachments: {},
    managed: MANAGED_NONE,
  };
};

describe("stamps", () => {
  test("the same bytes stamp the same, and a row that moved stamps anew", () => {
    expect(stampOf({ rows: [row("a")], trunks: {} })).toBe(stampOf({ rows: [row("a")], trunks: {} }));
    expect(stampOf({ rows: [row("a")], trunks: {} })).not.toBe(stampOf({ rows: [row("a", "working")], trunks: {} }));
    expect(stampsOf({ rows: [row("a")], trunks: {}, repos: [], visits: {}, themes: [] }).rows).toBe(
      stampOf({ rows: [row("a")], trunks: {} }),
    );
  });
});

describe("the visits stamp", () => {
  test("a score that decayed stamps the same; a page, a title or the order moved stamps anew", () => {
    const list = (score: number, title = "Docs") => ({
      r: [
        { path: "/a", score, last: 1, title },
        { path: "/b", score: 0.4, last: 1 },
      ],
    });
    expect(visitsStamp(list(0.9))).toBe(visitsStamp(list(0.87)));
    expect(visitsStamp(list(0.9))).not.toBe(visitsStamp(list(0.9, "Guides")));
    expect(visitsStamp({ r: [...list(0.9).r].reverse() })).not.toBe(visitsStamp(list(0.9)));
    expect(visitsStamp({})).not.toBe(visitsStamp(list(0.9)));
  });
});

describe("the hello for what a socket holds", () => {
  const full = hello([row("a")]);
  test("no known: everything", () => {
    expect(shapeHello(full, null)).toBe(full);
  });
  test("every part held: the light fields alone, marked same", () => {
    const got = shapeHello(full, full.stamps);
    expect(got.same).toBe(true);
    expect(got).not.toHaveProperty("rows");
    expect(got).not.toHaveProperty("trunks");
    expect(got).not.toHaveProperty("repos");
    expect(got).not.toHaveProperty("visits");
    expect(got).not.toHaveProperty("themes");
    expect(got.stamps).toEqual(full.stamps);
    expect(got.machine).toBe("box");
  });
  test("the themes held and a row moved: the rows and the rest, no themes", () => {
    const moved = hello([row("a", "working")]);
    const got = shapeHello(moved, full.stamps);
    expect(got.same).toBeUndefined();
    expect(got).toHaveProperty("rows");
    expect(got).not.toHaveProperty("themes");
  });
  test("the rows held and a theme imported: same, with the themes", () => {
    const imported = hello([row("a")], [theme, { ...theme, id: "t2" }]);
    const got = shapeHello(imported, full.stamps);
    expect(got.same).toBe(true);
    expect(got.themes).toHaveLength(2);
  });
  test("a part the page could not vouch for is never a match", () => {
    const got = shapeHello(full, { ...full.stamps, rows: "" });
    expect(got.same).toBeUndefined();
    expect(got).toHaveProperty("rows");
    expect(got).not.toHaveProperty("themes");
  });
});
