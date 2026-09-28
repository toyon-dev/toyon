import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { BackendShare, DEBOUNCE_MS, migrationMatch, rootMatch, touching } from "./backend.ts";

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
  const page = ["src/**", "index.html"];
  test("declared paths: those, plus the root and migration sets", () => {
    expect(touching(["server/index.ts"], ["server/**"], true, page)).toBe("server/index.ts");
    expect(touching(["src/App.tsx"], ["server/**"], true, page)).toBeUndefined();
    expect(touching(["src/App.tsx", "bun.lock"], ["server/**"], true, page)).toBe("bun.lock");
    expect(touching(["migrations/2.sql"], ["server/**"], true, page)).toBe("migrations/2.sql");
  });
  test("a declared empty list never flips, whatever changed", () => {
    expect(touching(["bun.lock", "migrations/2.sql", "server/x.ts"], [], true, page)).toBeUndefined();
  });
  test("nothing declared and nothing inferred: anything outside the page", () => {
    expect(touching(["src/App.tsx"], [], false, page)).toBeUndefined();
    expect(touching(["lib/util.ts"], [], false, page)).toBe("lib/util.ts");
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
        api: { cmd: "node --watch server/index.js", from: "trunk" },
        worker: { cmd: "node worker.js", from: "trunk", paths: ["jobs/**"] },
        db: { cmd: "docker compose up db", from: "trunk", paths: [] },
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

  function make(files: () => string[]) {
    const t = tmpRepo();
    cleanup = t.cleanup;
    // the repo's tree, for the paths read off the commands
    mkdirSync(join(t.repo, "server"), { recursive: true });
    writeFileSync(join(t.repo, "server/index.js"), "");
    writeFileSync(join(t.repo, "worker.js"), "");
    const state = new StateStore(t.paths, {
      repos: [{ ...repo, path: t.repo }],
      worktrees: [row("a"), row("m", { kind: "main" })],
      sessions: {},
    });
    const hub = new Hub();
    const owned: Array<[string, string[]]> = [];
    const share = new BackendShare({
      state,
      hub,
      runtime: { borrows: (id) => id === "a" && (state.worktree("a")?.owns?.length ?? 0) < 3 },
      own: async (id, names) => {
        owned.push([id, names]);
        const wt = state.requireWorktree(id);
        wt.owns = [...(wt.owns ?? []), ...names];
      },
      changed: async () => files(),
    });
    return { share, hub, state, owned };
  }

  test("a change under a proc's inferred paths takes that proc over, and only that one", async () => {
    const { share, owned } = make(() => ["server/index.js"]);
    await share.check("a");
    expect(owned).toEqual([["a", ["api"]]]);
    // nothing flips twice: the proc is its own now
    await share.check("a");
    expect(owned.length).toBe(1);
  });

  test("a lockfile takes over every proc that can flip; a migration too; the page alone takes none", async () => {
    const { share, owned } = make(() => ["bun.lock"]);
    await share.check("a");
    expect(owned).toEqual([["a", ["api", "worker"]]]);
    const m = make(() => ["src/migrations/1.sql"]);
    await m.share.check("a");
    expect(m.owned).toEqual([["a", ["api", "worker"]]]);
    const p = make(() => ["src/App.tsx", "index.html"]);
    await p.share.check("a");
    expect(p.owned).toEqual([]);
  });

  test("declared paths are read as written", async () => {
    const { share, owned } = make(() => ["jobs/mail.js"]);
    await share.check("a");
    expect(owned).toEqual([["a", ["worker"]]]);
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
    expect(owned).toEqual([["a", ["api"]]]);
    expect(share).toBeDefined();
  });
});
