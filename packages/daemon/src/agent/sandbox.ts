// The write boundary of a worktree, and the file that makes Claude Code enforce it. Two layers,
// neither of which the model can talk its way past:
//   1. OS sandbox (Seatbelt on macOS, bubblewrap on Linux) for everything Bash spawns. Claude Code
//      reads it from settings; Codex has its own. Writes are confined to the worktree, its git
//      metadata, /tmp and package-manager caches.
//   2. The ACP permission policy (policy.ts) for the file tools, which bypass Bash and therefore
//      the sandbox: the same allow-list, applied to the path in each permission request.
// Reads are left open: the default sandbox allows them, and blocking them breaks too much
// (global tool configs, resolved node_modules, /usr/lib).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "../core/log.ts";
import { git } from "../git/exec.ts";
import { canonical, within } from "./bounds.ts";

export interface Bounds {
  /** canonical worktree root */
  root: string;
  /** raw and canonical forms, so `/tmp` (→ /private/tmp on macOS) matches resolved targets */
  allowWrite: string[];
  denyWrite: string[];
  /** the main repo's git dir when this is a linked worktree (outside root), else null */
  gitDir: string | null;
}

const CACHE_DIRS = [".bun", ".npm", ".cache", ".yarn", ".pnpm-store", "Library/Caches"].map((d) =>
  resolve(homedir(), d),
);

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export async function worktreeBounds(cwd: string): Promise<Bounds> {
  const root = canonical(cwd);
  // a linked worktree's `.git` is a pointer file; commits write into the main
  // repo's .git/worktrees/<name>, which must stay writable or git breaks
  const common = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const gitDirRaw = common.ok && common.out ? canonical(common.out) : null;
  const gitDir = gitDirRaw && !within(gitDirRaw, root) ? gitDirRaw : null;
  const allowWrite = uniq([root, ...(gitDir ? [gitDir] : []), "/tmp", ...CACHE_DIRS].flatMap((p) => [p, canonical(p)]));
  // the agent must not be able to widen its own permissions from inside
  const denyWrite = [resolve(root, ".claude")];
  return { root, allowWrite, denyWrite, gitDir };
}

export const SETTINGS_REL = join(".claude", "settings.local.json");

/** the settings toyon owns; anything else in the file is the user's and left alone */
export function claudeLocalSettings(b: Bounds): { sandbox: unknown; permissions: { defaultMode: string } } {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: b.allowWrite, denyWrite: b.denyWrite },
      network: { allowLocalBinding: true },
    },
    // "default" so every Edit/Write reaches the permission policy; bypass would skip it
    permissions: { defaultMode: "default" },
  };
}

/** Write (or refresh) <wt>/.claude/settings.local.json and keep it out of git. Idempotent, so it
 * runs before every adapter spawn. */
export async function writeClaudeLocalSettings(cwd: string, b: Bounds): Promise<void> {
  const file = join(cwd, SETTINGS_REL);
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
    } catch (e) {
      const bak = `${file}.bak`;
      log.warn("sandbox", `${file} is not valid JSON; keeping it as ${bak}`, e);
      renameSync(file, bak);
    }
  }
  const ours = claudeLocalSettings(b);
  const perms = (
    existing.permissions && typeof existing.permissions === "object" ? existing.permissions : {}
  ) as Record<string, unknown>;
  const next = { ...existing, sandbox: ours.sandbox, permissions: { ...perms, ...ours.permissions } };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  await excludeFromGit(cwd, SETTINGS_REL);
}

/** add a pattern to the repo's info/exclude (shared by linked worktrees) once */
async function excludeFromGit(cwd: string, pattern: string): Promise<void> {
  const r = await git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  if (!r.ok || !r.out) return log.warn("sandbox", `cannot locate info/exclude for ${cwd}: ${r.err}`);
  const file = r.out;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split("\n").some((l) => l.trim() === pattern)) return;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}
