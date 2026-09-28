// The artifact cache: what a worktree built to pass the repo's check (node_modules, .mypy_cache,
// .testmondata) kept under the daemon's home and cloned into the repo's next worktree before its
// setup runs, so the install finds its work done and mypy and testmon start from the last run's
// answers rather than from nothing.
//
// An entry is keyed twice. Its family is the platform, the lockfiles, the key files and the tool
// versions: what the artifacts were built by, and what makes one from another machine or another
// lockfile useless here. Within a family an entry is named for the commit the worktree stood on
// and the moment it was kept. A restore takes the newest entry at its own base commit, else the
// newest in the family: an incremental cache from a neighbouring commit is mostly right and its
// own tool checks every answer in it, and node_modules does not depend on the commit at all.
//
// A publish clones each path into a directory beside the family's entries and renames it in
// whole, so a reader never meets a half-written entry. An entry is never changed after that, only
// added beside and pruned, which is what lets a restore read one while a publish lands.
//
// Layout: <cacheDir>/<repoId>/<family>/<base12>-<at36>/{manifest.json, <path>...}

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseOf, type CachePolicy, cachePolicy, type RepoInfo, SIDECARS, type WorktreeInfo } from "@toyon/shared";
import { type CloneHow, type CloneResult, cloneTree } from "../core/clone.ts";
import type { Hub } from "../core/hub.ts";
import { fireAndForget, log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { StateStore } from "../core/state.ts";
import { git, lockfileHash, run } from "../git/exec.ts";
import { worktreeEnv } from "../runtime/registry.ts";

/** entries kept per family: the newest few, so a base commit a worktree still sits on has one */
export const KEEP_PER_FAMILY = 3;
/** a family nothing has read or written for this long goes at boot */
export const STALE_MS = 30 * 24 * 3_600_000;
/** the name a publish builds under until its rename; never read as an entry */
const TMP = ".tmp-";
const MANIFEST = "manifest.json";

/** what an entry says about itself, beside the paths */
export interface Manifest {
  at: number;
  /** the commit the worktree's work stood on when the entry was kept */
  base: string;
  platform: string;
  /** the version commands asked, and what each printed */
  tools: Record<string, string>;
  /** the paths kept, as the settings name them; sidecars ride with their file */
  paths: string[];
}

interface Entry {
  dir: string;
  /** the base commit's first twelve characters, as the name carries them */
  base: string;
  at: number;
}

interface Family {
  key: string;
  platform: string;
  tools: Record<string, string>;
}

/** the version commands the lockfiles present imply, when the settings name none: the runtime
 * a native module was built against, the interpreter a bytecode cache was written by */
export function defaultTools(dir: string): string[] {
  const has = (...files: string[]) => files.some((f) => existsSync(join(dir, f)));
  const out: string[] = [];
  if (has("bun.lock", "bun.lockb")) out.push("bun --version");
  if (has("package-lock.json", "pnpm-lock.yaml", "yarn.lock")) out.push("node --version");
  if (has("uv.lock", "poetry.lock", "requirements.txt")) out.push("python3 --version");
  if (has("Cargo.lock")) out.push("rustc --version");
  return out;
}

/** the path and the sidecars beside it that exist under `root`, the file first: a database
 * without its WAL is behind, and a WAL without its database is nothing */
function withSidecars(root: string, rel: string): string[] {
  return [rel, ...SIDECARS.map((s) => rel + s)].filter((n) => existsSync(join(root, n)));
}

const entryName = (base: string, at: number) => `${base.slice(0, 12)}-${at.toString(36)}`;

/** the family's entries, newest first: those named for a base and a moment, carrying a manifest,
 * which a publish writes last before the rename that makes the entry one */
async function listEntries(familyDir: string): Promise<Entry[]> {
  let names: string[];
  try {
    names = await readdir(familyDir);
  } catch {
    // no family yet: no entries
    return [];
  }
  const out: Entry[] = [];
  for (const name of names) {
    const m = /^([0-9a-f]{12})-([0-9a-z]+)$/.exec(name);
    if (!m?.[1] || !m[2]) continue;
    const dir = join(familyDir, name);
    if (!existsSync(join(dir, MANIFEST))) continue;
    out.push({ dir, base: m[1], at: Number.parseInt(m[2], 36) });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** what a version command prints, on the person's own PATH (a login shell, as the terminal and
 * the check have), both pipes since some tools print their version to stderr. A command that
 * fails keys by its failure, so a machine without the tool is its own family. */
async function toolOutput(cmd: string, cwd: string, env: Record<string, string>): Promise<string> {
  const r = await run(process.env.SHELL || "sh", ["-lc", cmd], cwd, env);
  const text = `${r.out}\n${r.err}`.trim();
  return r.ok ? text : `exit ${r.exit}: ${text}`;
}

const list = (paths: string[]) => paths.join(", ");

export interface ArtifactCacheDeps {
  paths: Paths;
  state: StateStore;
  hub: Hub;
  /** the copy itself; cloneTree, or a test's own */
  clone?: (src: string, dst: string) => Promise<CloneResult>;
  /** what a version command prints, run in the worktree */
  tool?: (cmd: string, cwd: string, env: Record<string, string>) => Promise<string>;
}

export class ArtifactCache {
  /** worktrees with a publish under way: a check that passes meanwhile is the next one's */
  private publishing = new Set<string>();
  /** the entries being made, by family and base: a batch of worktrees settling together on one
   * base clones once, and the rest read the entry they would have written */
  private making = new Set<string>();

  constructor(private d: ArtifactCacheDeps) {
    d.hub.on("checkPassed", (id) => fireAndForget(id, this.publish(id), "cache publish"));
  }

  /** The entry for the worktree's family and base, cloned in path by path before setup runs. A
   * path already there is left alone (an adopted directory, a second setup). Says on the setup
   * stream what came, or that nothing matched. Never throws: setup goes on either way, and the
   * install does what the cache would have. */
  async restore(wt: WorktreeInfo, repo: RepoInfo, say: (line: string) => void): Promise<string[]> {
    const policy = cachePolicy(repo.config);
    if (!policy) return [];
    const started = Date.now();
    try {
      const family = await this.family(wt, repo, policy);
      const base = await this.baseCommit(wt, repo);
      const entries = await listEntries(join(this.d.paths.cacheDir, repo.id, family.key));
      const entry = entries.find((e) => e.base === base.slice(0, 12)) ?? entries[0];
      if (!entry) {
        say(`cache: nothing kept for these lockfiles and tools on ${family.platform}`);
        return [];
      }
      const restored: string[] = [];
      for (const rel of policy.paths) {
        if (existsSync(join(wt.path, rel))) continue;
        const names = withSidecars(entry.dir, rel);
        if (names.length === 0) continue;
        let whole = true;
        for (const name of names) {
          const r = await (this.d.clone ?? cloneTree)(join(entry.dir, name), join(wt.path, name));
          if (r.ok) continue;
          say(`cache: could not restore ${name}: ${r.error}`);
          log.warn(wt.id, `cache: could not restore ${name}`, r.error);
          whole = false;
          break;
        }
        if (whole) restored.push(rel);
      }
      // the entry was read: what the boot sweep counts as use
      await utimes(entry.dir, new Date(), new Date()).catch(() => {});
      if (restored.length > 0)
        say(`cache: restored ${list(restored)} from ${entry.base.slice(0, 7)} in ${Date.now() - started}ms`);
      return restored;
    } catch (e) {
      log.warn(wt.id, "cache restore failed", e);
      say(`cache: restore failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** The worktree's paths kept as one entry, once the check has passed: cloned into a directory
   * beside the family's entries and renamed in whole, so nothing reads it half-written. One at a
   * time per worktree, and once per base commit per family: a second passing check on the same
   * base, from this worktree or a sibling in the same batch, has nothing newer to keep than what
   * the tools already validated, and a batch of four would clone node_modules four times. The
   * emit comes with no turn started since the check, and the clone takes seconds; a turn that
   * starts inside them can leave a torn cache file, which the tool that owns it treats as a miss
   * for that file. */
  async publish(worktreeId: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt || wt.kind === "main") return;
    const repo = this.d.state.repo(wt.repoId);
    const policy = repo && cachePolicy(repo.config);
    if (!repo || !policy || this.publishing.has(worktreeId)) return;
    this.publishing.add(worktreeId);
    const started = Date.now();
    let tmp: string | undefined;
    let slot: string | undefined;
    try {
      const present = policy.paths.filter((rel) => existsSync(join(wt.path, rel)));
      if (present.length === 0) return;
      const family = await this.family(wt, repo, policy);
      const base = await this.baseCommit(wt, repo);
      const familyDir = join(this.d.paths.cacheDir, repo.id, family.key);
      const key = `${familyDir}/${base.slice(0, 12)}`;
      const kept = (await listEntries(familyDir)).find((e) => e.base === base.slice(0, 12));
      if (kept || this.making.has(key)) {
        log.info(worktreeId, `cache: skipped, ${base.slice(0, 7)} is ${kept ? "already" : "being"} kept for this key`);
        return;
      }
      slot = key;
      this.making.add(key);
      const at = Date.now();
      const name = entryName(base, at);
      tmp = join(familyDir, `${TMP}${name}`);
      await mkdir(tmp, { recursive: true });
      // how the disk took the copy: a plain copy means every entry is the tree's full size
      let how: CloneHow = "clonefile";
      for (const rel of present) {
        for (const n of withSidecars(wt.path, rel)) {
          const r = await (this.d.clone ?? cloneTree)(join(wt.path, n), join(tmp, n));
          if (!r.ok) throw new Error(`could not keep ${n}: ${r.error}`);
          how = r.how;
        }
      }
      const manifest: Manifest = { at, base, platform: family.platform, tools: family.tools, paths: present };
      await writeFile(join(tmp, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
      await rename(tmp, join(familyDir, name));
      tmp = undefined;
      log.info(
        worktreeId,
        `cache: kept ${list(present)} for ${base.slice(0, 7)} via ${how} in ${Date.now() - started}ms`,
      );
      await this.prune(familyDir);
    } catch (e) {
      log.warn(worktreeId, "cache publish failed", e);
      if (tmp) await rm(tmp, { recursive: true, force: true });
    } finally {
      if (slot) this.making.delete(slot);
      this.publishing.delete(worktreeId);
    }
  }

  /** The family's newest few entries stay. A restore mid-clone of an older one is the race this
   * bounds: it takes that many publishes in the seconds a clone lasts, and a clone that fails is
   * a restore that says so and a setup that installs. */
  private async prune(familyDir: string): Promise<void> {
    const entries = await listEntries(familyDir);
    for (const e of entries.slice(KEEP_PER_FAMILY)) await rm(e.dir, { recursive: true, force: true });
  }

  /** At boot: what the last daemon died under (a publish never renamed), the families nothing
   * has read or written in a month, and the repos toyon no longer has. */
  async sweep(): Promise<void> {
    const root = this.d.paths.cacheDir;
    let repoIds: string[];
    try {
      repoIds = await readdir(root);
    } catch {
      // no cache directory yet: nothing kept
      return;
    }
    for (const repoId of repoIds) {
      const repoDir = join(root, repoId);
      if (!this.d.state.repo(repoId)) {
        await rm(repoDir, { recursive: true, force: true });
        continue;
      }
      let families: string[];
      try {
        families = await readdir(repoDir);
      } catch {
        // a file where a directory was expected, or gone meanwhile: nothing to sweep
        continue;
      }
      for (const family of families) {
        const familyDir = join(repoDir, family);
        let names: string[];
        try {
          names = await readdir(familyDir);
        } catch {
          continue;
        }
        for (const n of names) if (n.startsWith(TMP)) await rm(join(familyDir, n), { recursive: true, force: true });
        const entries = await listEntries(familyDir);
        let newest = 0;
        for (const e of entries) {
          const s = await stat(e.dir).catch(() => null);
          if (s) newest = Math.max(newest, s.mtimeMs);
        }
        if (Date.now() - newest > STALE_MS) await rm(familyDir, { recursive: true, force: true });
      }
    }
  }

  /** what the artifacts are built by: the platform, every lockfile, the key files as they stand
   * (absent is a fact of its own), and what each version command prints */
  private async family(wt: WorktreeInfo, repo: RepoInfo, policy: CachePolicy): Promise<Family> {
    const platform = `${process.platform}-${process.arch}`;
    const h = createHash("sha1");
    h.update(`${platform}\0${lockfileHash(wt.path)}`);
    for (const f of policy.key) {
      h.update(`\0${f}\0`);
      try {
        h.update(readFileSync(join(wt.path, f)));
      } catch {
        h.update("(absent)");
      }
    }
    const tools: Record<string, string> = {};
    for (const cmd of policy.tools ?? defaultTools(wt.path)) {
      const out = await (this.d.tool ?? toolOutput)(cmd, wt.path, worktreeEnv(wt, repo));
      tools[cmd] = out;
      h.update(`\0${cmd}\0${out}`);
    }
    return { key: h.digest("hex").slice(0, 16), platform, tools };
  }

  /** the commit the worktree's work stands on: its merge base with the branch it lands on, which
   * is HEAD itself for one just cut from it */
  private async baseCommit(wt: WorktreeInfo, repo: RepoInfo): Promise<string> {
    const r = await git(wt.path, "merge-base", "HEAD", baseOf(repo));
    if (r.ok && r.out) return r.out;
    const head = await git(wt.path, "rev-parse", "HEAD");
    return head.out || "0".repeat(40);
  }
}
