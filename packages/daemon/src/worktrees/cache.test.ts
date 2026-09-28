import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoInfo, ToyonConfig, WorktreeInfo } from "@toyon/shared";
import { sh, tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { cloneTree } from "../core/clone.ts";
import { Hub } from "../core/hub.ts";
import { StateStore } from "../core/state.ts";
import { GIT } from "../git/exec.ts";
import { ArtifactCache, defaultTools, KEEP_PER_FAMILY, type Manifest, STALE_MS } from "./cache.ts";

// Real git worktrees in a throwaway repo, the clone on the real filesystem (APFS clones here, a
// plain copy on ext4: the ladder is the same either way) and the version commands stubbed, so
// what an entry is keyed by is exactly what the test says the tools answered.

const CACHE: ToyonConfig["cache"] = {
  paths: ["node_modules", ".testmondata", ".mypy_cache"],
  tools: ["tool --version"],
};

type World = ReturnType<typeof world>;
function world() {
  const t = tmpRepo();
  const repo: RepoInfo = {
    id: "r1",
    path: t.repo,
    name: "repo",
    defaultBranch: "main",
    config: { run: {}, check: "true", cache: CACHE },
    configFile: ".toyon/settings.json",
    needsSetup: false,
  };
  const state = new StateStore(t.paths, { repos: [repo], worktrees: [], sessions: {} });
  const hub = new Hub();
  const versions = { "tool --version": "1.0" };
  const cache = new ArtifactCache({
    paths: t.paths,
    state,
    hub,
    tool: async (cmd) => versions[cmd as keyof typeof versions] ?? "unknown",
  });
  let n = 0;
  /** a worktree of the repo at `ref`, recorded, with the artifacts written into it */
  const worktree = (ref = "main", files: Record<string, string> = {}): WorktreeInfo => {
    const id = `w${++n}`;
    const path = join(t.repo, "..", id);
    sh(t.repo, GIT, "worktree", "add", "-q", "--detach", path, ref);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(path, rel, ".."), { recursive: true });
      writeFileSync(join(path, rel), body);
    }
    const wt: WorktreeInfo = {
      id,
      repoId: "r1",
      path,
      branch: ref,
      kind: "worktree",
      proxyPort: 1,
      title: id,
      createdAt: 0,
    };
    state.addWorktree(wt);
    return wt;
  };
  const said: string[] = [];
  const restore = (wt: WorktreeInfo) => cache.restore(wt, repo, (line) => said.push(line));
  const familyDirs = () => {
    const repoDir = join(t.paths.cacheDir, "r1");
    return existsSync(repoDir) ? readdirSync(repoDir).map((f) => join(repoDir, f)) : [];
  };
  const entries = () => familyDirs().flatMap((f) => readdirSync(f).map((e) => join(f, e)));
  const commit = (msg: string) => {
    writeFileSync(join(t.repo, msg), `${msg}\n`);
    sh(t.repo, GIT, "add", "-A");
    sh(t.repo, GIT, "commit", "-qm", msg);
    return sh(t.repo, GIT, "rev-parse", "HEAD");
  };
  return { ...t, repo, state, hub, cache, versions, worktree, said, restore, familyDirs, entries, commit };
}

let w: World;
beforeEach(() => {
  w = world();
});
afterEach(() => w.cleanup());

const NM = { "node_modules/dep/index.js": "module.exports = 1\n" };

describe("publish", () => {
  test("keeps the paths present, a database with its WAL, under a manifest, and the rest not at all", async () => {
    const wt = w.worktree("main", {
      ...NM,
      ".testmondata": "db",
      ".testmondata-wal": "wal",
      ".testmondata-shm": "shm",
    });
    await w.cache.publish(wt.id);
    const [entry] = w.entries();
    expect(entry).toBeDefined();
    expect(readFileSync(join(entry!, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1\n");
    expect(readFileSync(join(entry!, ".testmondata-wal"), "utf8")).toBe("wal");
    // the shared-memory index is the next open's to rebuild
    expect(existsSync(join(entry!, ".testmondata-shm"))).toBe(false);
    // .mypy_cache was not in the tree: not kept, not claimed
    expect(existsSync(join(entry!, ".mypy_cache"))).toBe(false);
    const manifest: Manifest = JSON.parse(readFileSync(join(entry!, "manifest.json"), "utf8"));
    expect(manifest.paths).toEqual(["node_modules", ".testmondata"]);
    expect(manifest.tools).toEqual({ "tool --version": "1.0" });
    expect(manifest.base).toBe(sh(w.repo.path, GIT, "rev-parse", "main"));
    expect(manifest.platform).toBe(`${process.platform}-${process.arch}`);
  });

  test("a tree with none of the paths keeps nothing, and main never publishes", async () => {
    const wt = w.worktree("main");
    await w.cache.publish(wt.id);
    expect(w.entries()).toEqual([]);
    const main = w.worktree("main", NM);
    main.kind = "main";
    await w.cache.publish(main.id);
    expect(w.entries()).toEqual([]);
  });

  test("the hub's checkPassed is what publishes", async () => {
    const wt = w.worktree("main", NM);
    w.hub.emit("checkPassed", wt.id);
    for (let i = 0; i < 100 && w.entries().length === 0; i++) await Bun.sleep(10);
    expect(w.entries().length).toBe(1);
  });

  test("a family keeps its newest few entries, one per base commit", async () => {
    for (let i = 0; i <= KEEP_PER_FAMILY; i++) {
      await w.cache.publish(w.worktree("main", NM).id);
      w.commit(`c${i}`);
    }
    expect(w.entries().length).toBe(KEEP_PER_FAMILY);
  });

  test("a base already kept for the key is skipped, from the same worktree or another", async () => {
    const first = w.worktree("main", NM);
    await w.cache.publish(first.id);
    await w.cache.publish(first.id);
    await w.cache.publish(w.worktree("main", NM).id);
    expect(w.entries().length).toBe(1);
    // a base the key has not seen is kept beside it
    w.commit("second");
    await w.cache.publish(w.worktree("main", NM).id);
    expect(w.entries().length).toBe(2);
  });

  test("a batch settling together on one base clones once", async () => {
    let clones = 0;
    const counting = new ArtifactCache({
      paths: w.paths,
      state: w.state,
      hub: new Hub(),
      tool: async () => "1.0",
      clone: (s, d) => {
        clones++;
        return cloneTree(s, d);
      },
    });
    const batch = [1, 2, 3, 4].map(() => w.worktree("main", NM));
    await Promise.all(batch.map((wt) => counting.publish(wt.id)));
    expect(clones).toBe(1);
    expect(w.entries().length).toBe(1);
  });
});

describe("restore", () => {
  test("clones what was kept into a copy that lacks it, says so, and leaves what is there alone", async () => {
    const src = w.worktree("main", { ...NM, ".testmondata": "db", ".testmondata-wal": "wal" });
    await w.cache.publish(src.id);
    const dst = w.worktree("main", { ".testmondata": "mine" });
    expect(await w.restore(dst)).toEqual(["node_modules"]);
    expect(readFileSync(join(dst.path, "node_modules/dep/index.js"), "utf8")).toBe("module.exports = 1\n");
    expect(readFileSync(join(dst.path, ".testmondata"), "utf8")).toBe("mine");
    expect(existsSync(join(dst.path, ".testmondata-wal"))).toBe(false);
    expect(w.said[0]).toMatch(/^cache: restored node_modules from [0-9a-f]{7} in \d+ms$/);
  });

  test("nothing kept for the family says so and restores nothing", async () => {
    const dst = w.worktree("main");
    expect(await w.restore(dst)).toEqual([]);
    expect(w.said).toEqual([
      `cache: nothing kept for these lockfiles and tools on ${process.platform}-${process.arch}`,
    ]);
  });

  test("a different tool version, lockfile or key file is another family", async () => {
    const src = w.worktree("main", NM);
    await w.cache.publish(src.id);
    w.versions["tool --version"] = "2.0";
    expect(await w.restore(w.worktree("main"))).toEqual([]);
    w.versions["tool --version"] = "1.0";
    expect(await w.restore(w.worktree("main"))).toEqual(["node_modules"]);
    // a lockfile the source did not have
    expect(await w.restore(w.worktree("main", { "bun.lock": "{}" }))).toEqual([]);
    // a key file that differs
    w.repo.config.cache = { ...CACHE, key: ["pyproject.toml"] };
    await w.cache.publish(w.worktree("main", { ...NM, "pyproject.toml": "a" }).id);
    expect(await w.restore(w.worktree("main", { "pyproject.toml": "b" }))).toEqual([]);
    expect(await w.restore(w.worktree("main", { "pyproject.toml": "a" }))).toEqual(["node_modules"]);
  });

  test("the entry at the copy's own base commit wins over a newer one; a base with none takes the newest", async () => {
    const c0 = sh(w.repo.path, GIT, "rev-parse", "HEAD");
    const old = w.worktree(c0, { "node_modules/which": "at c0\n" });
    await w.cache.publish(old.id);
    await Bun.sleep(2);
    const c1 = w.commit("second");
    const fresh = w.worktree(c1, { "node_modules/which": "at c1\n" });
    await w.cache.publish(fresh.id);
    const read = async (ref: string) => {
      const wt = w.worktree(ref);
      await w.restore(wt);
      return readFileSync(join(wt.path, "node_modules/which"), "utf8").trim();
    };
    expect(await read(c0)).toBe("at c0");
    expect(await read(c1)).toBe("at c1");
    w.commit("third");
    expect(await read("main")).toBe("at c1");
  });

  test("a clone that fails is said, and the setup goes on with the rest", async () => {
    const src = w.worktree("main", { ...NM, ".testmondata": "db" });
    await w.cache.publish(src.id);
    const failing = new ArtifactCache({
      paths: w.paths,
      state: w.state,
      hub: new Hub(),
      tool: async () => "1.0",
      clone: async (s) =>
        s.endsWith("node_modules") ? { ok: false, error: "disk full" } : { ok: true, how: "copy", ms: 0 },
    });
    const dst = w.worktree("main");
    const said: string[] = [];
    expect(await failing.restore(dst, w.repo, (l) => said.push(l))).toEqual([".testmondata"]);
    expect(said[0]).toBe("cache: could not restore node_modules: disk full");
  });
});

describe("sweep", () => {
  test("drops a publish left unrenamed, a family nobody has used in a month, and a repo toyon no longer has", async () => {
    const src = w.worktree("main", NM);
    await w.cache.publish(src.id);
    const [family] = w.familyDirs();
    const tmp = join(family!, ".tmp-deadbeefdead-1");
    mkdirSync(tmp, { recursive: true });
    const gone = join(w.paths.cacheDir, "nobody", "f", "deadbeefdead-1");
    mkdirSync(gone, { recursive: true });
    writeFileSync(join(gone, "manifest.json"), "{}");
    await w.cache.sweep();
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(join(w.paths.cacheDir, "nobody"))).toBe(false);
    expect(w.entries().length).toBe(1);
    // a restore is use: the entry stays young; a month untouched, and the family goes
    const stale = new Date(Date.now() - STALE_MS - 1000);
    utimesSync(w.entries()[0]!, stale, stale);
    await w.restore(w.worktree("main"));
    await w.cache.sweep();
    expect(w.entries().length).toBe(1);
    utimesSync(w.entries()[0]!, stale, stale);
    await w.cache.sweep();
    expect(w.familyDirs()).toEqual([]);
  });
});

describe("defaultTools", () => {
  test("follows from the lockfiles present", () => {
    const dir = join(w.paths.home, "tools");
    mkdirSync(dir);
    expect(defaultTools(dir)).toEqual([]);
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(join(dir, "uv.lock"), "");
    expect(defaultTools(dir)).toEqual(["bun --version", "python3 --version"]);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    writeFileSync(join(dir, "Cargo.lock"), "");
    expect(defaultTools(dir)).toEqual(["bun --version", "node --version", "python3 --version", "rustc --version"]);
  });
});
