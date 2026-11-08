import { describe, expect, test } from "bun:test";
import type { TierProc } from "@toyon/shared";
import type { WorktreeConfig } from "../repos/config.ts";
import { resolveRun, spawnsOf } from "./profile.ts";

const base: WorktreeConfig = {
  config: { run: { api: "a", web: "w", worker: "k" } },
  file: ".toyon/settings.json",
};
const NONE: Record<string, TierProc> = {};

describe("resolveRun", () => {
  test("no tier: every proc is the worktree's own, web previews", () => {
    const r = resolveRun(base, { id: "w", kind: "worktree" }, NONE);
    expect(Object.keys(r.procs)).toEqual(["api", "web", "worker"]);
    expect(r.shared).toEqual([]);
    expect(r.borrowed).toEqual([]);
    expect(r.pointed).toEqual({});
    expect(r.preview).toBe("web");
    expect(spawnsOf(r)).toEqual(["api", "web", "worker"]);
  });

  test("config.preview wins when it names a proc, else first proc", () => {
    expect(
      resolveRun({ ...base, config: { ...base.config, preview: "api" } }, { id: "w", kind: "worktree" }, NONE).preview,
    ).toBe("api");
    expect(resolveRun({ ...base, config: { run: { job: "j" } } }, { id: "w", kind: "worktree" }, NONE).preview).toBe(
      "job",
    );
  });
});

describe("resolveRun and the shared tier", () => {
  const tiered: WorktreeConfig = {
    ...base,
    config: {
      run: {
        web: "w",
        api: { cmd: "a", paths: ["server/**"], remotes: { stage: "https://api.stage.example.com" } },
        db: { cmd: "d", paths: [] },
        worker: "k",
      },
    },
  };
  const tier: Record<string, TierProc> = {
    api: { paths: ["server/**"], declared: true },
    db: { paths: [], declared: true },
  };

  test("the tier comes off the repo in run order, with its paths; a command outside it is every copy's", () => {
    const r = resolveRun(tiered, { id: "w", kind: "worktree" }, tier);
    expect(r.procs).toEqual({ web: "w", api: "a", db: "d", worker: "k" });
    expect(r.shared).toEqual(["api", "db"]);
    expect(r.paths).toEqual({ api: ["server/**"], db: [] });
    expect(r.preview).toBe("web");
    expect(spawnsOf(r)).toEqual(["web", "worker"]);
  });

  test("a tier name the worktree's own file does not have is nobody's here; one the tier lacks runs here", () => {
    // the branch renamed api to server: main shares api, which this file does not name, and the
    // branch's server is not main's to give
    const renamed: WorktreeConfig = { ...tiered, config: { run: { web: "w", server: "s", db: "d" } } };
    const r = resolveRun(renamed, { id: "w", kind: "worktree" }, tier);
    expect(r.shared).toEqual(["db"]);
    expect(r.borrowed).toEqual(["db"]);
    expect(spawnsOf(r)).toEqual(["web", "server"]);
  });

  test("a worktree borrows what it does not own or point away; main borrows nothing", () => {
    expect(resolveRun(tiered, { id: "w", kind: "worktree" }, tier).borrowed).toEqual(["api", "db"]);
    expect(
      resolveRun(tiered, { id: "w", kind: "worktree", sources: { api: { at: { by: "hand" } } } }, tier).borrowed,
    ).toEqual(["db"]);
    expect(resolveRun(tiered, { id: "w", kind: "spare" }, tier).borrowed).toEqual(["api", "db"]);
    expect(resolveRun(tiered, { id: "m", kind: "main" }, tier).borrowed).toEqual([]);
    expect(resolveRun(tiered, { id: "m", kind: "main" }, tier).shared).toEqual(["api", "db"]);
  });

  test("a pointed proc resolves to its URL and is neither borrowed nor spawned; main points nowhere", () => {
    const r = resolveRun(tiered, { id: "w", kind: "worktree", sources: { api: { at: { remote: "stage" } } } }, tier);
    expect(r.pointed).toEqual({ api: "https://api.stage.example.com" });
    expect(r.borrowed).toEqual(["db"]);
    expect(spawnsOf(r)).toEqual(["web", "worker"]);
    expect(
      resolveRun(tiered, { id: "m", kind: "main", sources: { api: { at: { remote: "stage" } } } }, tier).pointed,
    ).toEqual({});
  });

  test("a remote the file no longer names falls back to main's", () => {
    const r = resolveRun(
      tiered,
      { id: "w", kind: "worktree", sources: { api: { at: { remote: "gone" } }, worker: { at: { remote: "stage" } } } },
      tier,
    );
    expect(r.pointed).toEqual({});
    expect(r.borrowed).toEqual(["api", "db"]);
  });
});
