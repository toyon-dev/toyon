import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { tierOf } from "../repos/config.ts";
import { resolveRun } from "../runtime/run.ts";
import { BackendShare, DEBOUNCE_MS, migrationMatch, rootMatch, touched, touching, unheld } from "./backend.ts";

let cleanup = () => {};
afterEach(() => cleanup());

describe("the sets every shared proc flips on", () => {
  test("deps, env and containers at the root; migrations anywhere", () => {
    for (const f of [
      "package.json",
      "bun.lock",
      ".env",
      ".env.local",
      "docker-compose.yml",
      "compose.yaml",
      "Dockerfile",
    ]) {
      expect(rootMatch(f), f).toBe(true);
    }
    for (const f of ["src/package.json", "server/.env", "README.md"]) expect(rootMatch(f), f).toBe(false);
    for (const f of ["migrations/001.sql", "server/migrations/001.sql", "prisma/schema.prisma", "db/migrate/x.rb"]) {
      expect(migrationMatch(f), f).toBe(true);
    }
    expect(migrationMatch("src/migrationsHelper.ts")).toBe(false);
  });
});

describe("touching", () => {
  test("the proc's paths, plus the root and migration sets", () => {
    expect(touching(["server/index.ts"], ["server/**"])).toBe("server/index.ts");
    expect(touching(["src/App.tsx"], ["server/**"])).toBeUndefined();
    expect(touching(["src/App.tsx", "bun.lock"], ["server/**"])).toBe("bun.lock");
    expect(touching(["migrations/2.sql"], ["server/**"])).toBe("migrations/2.sql");
  });
  test("no paths never flips, whatever changed: the root and migration sets included", () => {
    expect(touching(["bun.lock", "migrations/2.sql", "server/x.ts", "lib/util.ts"], [])).toBeUndefined();
  });
  test("every touching file, in order; a hold keeps back the ones it names", () => {
    const hits = touched(["src/App.tsx", "server/a.ts", "bun.lock", "server/b.ts"], ["server/**"]);
    expect(hits).toEqual(["server/a.ts", "bun.lock", "server/b.ts"]);
    expect(unheld(hits, undefined)).toEqual(hits);
    expect(unheld(hits, { held: ["server/a.ts", "bun.lock"] })).toEqual(["server/b.ts"]);
    expect(unheld(hits, { held: hits })).toEqual([]);
  });
});

describe("BackendShare", () => {
  const repo: RepoInfo = {
    id: "r",
    path: "/nowhere",
    name: "x",
    defaultBranch: "main",
    config: {
      run: {
        web: "vite --port $PORT",
        api: { cmd: "node --watch server/index.js", remotes: { stage: "https://api.stage.example.com" } },
        worker: { cmd: "node worker.js", paths: ["jobs/**"] },
        db: { cmd: "docker compose up db", from: "trunk" },
        cron: "node cron.js",
      },
    },
    configFile: ".toyon/settings.json",
    needsSetup: false,
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

  function make(files: () => string[], extra: Partial<WorktreeInfo> = {}) {
    const t = tmpRepo();
    cleanup = t.cleanup;
    // the repo's tree, for the paths read off the commands
    mkdirSync(join(t.repo, "server"), { recursive: true });
    writeFileSync(join(t.repo, "server/index.js"), "");
    writeFileSync(join(t.repo, "worker.js"), "");
    writeFileSync(join(t.repo, "cron.js"), "");
    const config = { ...repo, path: t.repo };
    // the tier as the daemon settles it off the file and the tree: api by its folder, worker by its
    // written paths, db by the trunk's word with nothing to flip it; cron names a root file alone
    // and is every copy's
    const state = new StateStore(t.paths, {
      repos: [{ ...config, tier: tierOf(config.config, t.repo) }],
      worktrees: [row("a", extra), row("m", { kind: "main" })],
      sessions: {},
    });
    const hub = new Hub();
    const owned: Array<[string, string[], Record<string, string>]> = [];
    const behind: string[][] = [];
    const cfg = { config: config.config, file: config.configFile };
    const runOf = (id: string) => resolveRun(cfg, state.requireWorktree(id), state.requireRepo("r").tier ?? {});
    const borrowedOf = (id: string) => runOf(id).borrowed;
    const share = new BackendShare({
      state,
      hub,
      runtime: {
        borrows: (id) => id === "a" && borrowedOf(id).length > 0,
        points: (id) =>
          id === "a" && Object.values(state.worktree("a")?.sources ?? {}).some((s) => s.at && "remote" in s.at),
        markRemoteBehind: (_id, names) => {
          behind.push(names);
        },
        runOf: (id) => runOf(id),
      },
      own: async (id, names, why) => {
        owned.push([id, names, why]);
        const wt = state.requireWorktree(id);
        for (const n of names) wt.sources = { ...wt.sources, [n]: { at: { by: "edit" as const, file: why[n] } } };
      },
      changed: async () => files(),
    });
    return { share, hub, state, owned, behind };
  }

  test("a change under a proc's inferred paths takes that proc over, and only that one", async () => {
    const { share, owned } = make(() => ["server/index.js"]);
    await share.check("a");
    expect(owned).toEqual([["a", ["api"], { api: "server/index.js" }]]);
    // nothing flips twice: the proc is its own now
    await share.check("a");
    expect(owned.length).toBe(1);
  });

  test("a hand move back to main holds on the files it was made over; a further file flips", async () => {
    const files = ["server/index.js"];
    const { share, hub, owned } = make(() => files, { sources: { api: { held: ["server/index.js"] } } });
    // the signals that follow the move: the procs restarting, the agent's next tool
    hub.emit("proc", "a", { name: "web", status: "running" } as never);
    await Bun.sleep(DEBOUNCE_MS + 50);
    hub.emit("agent", "a", 1, { type: "tool-end", toolId: "t" });
    await Bun.sleep(DEBOUNCE_MS + 50);
    expect(owned).toEqual([]);
    // the same file edited again is still the file they moved it over
    await share.check("a");
    expect(owned).toEqual([]);
    files.push("server/routes.js");
    await share.check("a");
    expect(owned).toEqual([["a", ["api"], { api: "server/routes.js" }]]);
  });

  test("a change under a sibling file of the command's folder flips it too: the folder is the proc's", async () => {
    const { share, owned } = make(() => ["server/routes.js"]);
    await share.check("a");
    expect(owned.map((o) => o[1])).toEqual([["api"]]);
  });

  test("a command that names a root file alone is every copy's: nothing to flip", async () => {
    const { share, owned, state } = make(() => ["cron.js"]);
    expect(state.requireRepo("r").tier?.cron).toBeUndefined();
    await share.check("a");
    expect(owned).toEqual([]);
  });

  test("a pointed proc whose files change is marked behind, never taken; a change elsewhere clears the mark", async () => {
    const { share, owned, behind } = make(() => ["server/index.js"], { sources: { api: { at: { remote: "stage" } } } });
    await share.check("a");
    expect(owned).toEqual([]);
    expect(behind).toEqual([["api"]]);
    const clean = make(() => ["src/App.tsx"], { sources: { api: { at: { remote: "stage" } } } });
    await clean.share.check("a");
    expect(clean.behind).toEqual([[]]);
  });

  test("a worktree that only points is still checked", async () => {
    const { share, behind } = make(() => ["server/index.js"], {
      sources: { api: { at: { remote: "stage" } }, worker: { at: { by: "hand" } }, db: { at: { by: "hand" } } },
    });
    await share.check("a");
    expect(behind).toEqual([["api"]]);
  });

  test("a lockfile takes over every proc that can flip; a migration too; the page alone takes none", async () => {
    // the trunk's db has nothing of its own to rebuild, so neither counts for it
    const { share, owned, state } = make(() => ["bun.lock"]);
    expect(state.requireRepo("r").tier?.db).toEqual({ paths: [] });
    await share.check("a");
    expect(owned.map((o) => o[1])).toEqual([["api", "worker"]]);
    const m = make(() => ["src/migrations/1.sql"]);
    await m.share.check("a");
    expect(m.owned.map((o) => o[1])).toEqual([["api", "worker"]]);
    const p = make(() => ["src/App.tsx", "index.html"]);
    await p.share.check("a");
    expect(p.owned).toEqual([]);
  });

  test("declared paths are read as written", async () => {
    const { share, owned } = make(() => ["jobs/mail.js"]);
    await share.check("a");
    expect(owned.map((o) => o[1])).toEqual([["worker"]]);
  });

  test("main, and a worktree that borrows nothing, are left alone", async () => {
    const { share, owned } = make(() => ["server/index.js"]);
    await share.check("m");
    expect(owned).toEqual([]);
  });

  test("the signals of a burst are read once, after the last of them", async () => {
    const { share, hub, owned } = make(() => ["server/index.js"]);
    hub.emit("agent", "a", 1, { type: "tool-end", toolId: "t" });
    hub.emit("filesChanged", "a");
    hub.emit("turnSettled", "a", { end: "done", at: 0 } as never);
    expect(owned).toEqual([]);
    await Bun.sleep(DEBOUNCE_MS + 50);
    expect(owned.map((o) => o[1])).toEqual([["api"]]);
    expect(share).toBeDefined();
  });
});
