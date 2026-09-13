// The boundary an agent works inside, and the file that makes Claude Code enforce it. Two layers,
// neither of which the model can talk its way past:
//   1. An OS sandbox (Seatbelt on macOS, bubblewrap on Linux) around every shell command. Claude Code
//      builds it from its settings file, Codex from its own policy, and an agent that brings none
//      runs inside toyon's (confine.ts).
//   2. The ACP permission policy (policy.ts) for the file tools, which bypass the shell and so the
//      sandbox: the same lists, applied to the path in each permission request.
// Writes are confined to the worktree, its git metadata, the temp directories and package-manager
// caches. Reads stay open, since blocking them breaks too much (global tool configs, resolved
// node_modules, /usr/lib), except for toyon's own secrets: the token grants a shell on this machine,
// and agents.json names commands the daemon runs and may carry keys.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { log } from "../core/log.ts";
import { makePaths } from "../core/paths.ts";
import { excludeFromGit } from "../git/exclude.ts";
import { git } from "../git/exec.ts";
import { canonical, within } from "./bounds.ts";
import { claudeDenyRules } from "./commands.ts";
import type { AgentSpec } from "./registry.ts";

export interface Bounds {
  /** canonical worktree root */
  root: string;
  /** raw and canonical forms, so `/tmp` (→ /private/tmp on macOS) matches resolved targets */
  allowWrite: string[];
  /** refused even inside allowWrite: settings an agent would loosen itself with, and the secrets */
  denyWrite: string[];
  /** refused to read as well: toyon's own secrets */
  denyRead: string[];
  /** the main repo's git dir when this is a linked worktree (outside root), else null */
  gitDir: string | null;
}

/** what an agent's launch is built from: its bounds, and what its setup adds to its environment */
export interface Prepared {
  bounds: Bounds;
  env: Record<string, string>;
}

const CACHE_DIRS = [".bun", ".npm", ".cache", ".yarn", ".pnpm-store", "Library/Caches"].map((d) =>
  resolve(homedir(), d),
);

/** Where agents decide their own permissions, sandbox and hooks. Every agent is refused all of them,
 * not only its own: one agent rewriting another's would loosen that one the next time it starts in
 * the same worktree. */
const AGENT_SETTINGS = [".claude", ".codex", ".opencode", "opencode.json", "opencode.jsonc"];

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

const withCanonical = (p: string) => [p, canonical(p)];

/** the files no agent reads or writes, for the daemon whose home this is */
export function toyonSecrets(paths = makePaths()): string[] {
  return [paths.tokenFile, paths.agentsFile, paths.gitCredentialsFile];
}

export async function worktreeBounds(cwd: string, secrets: string[] = toyonSecrets()): Promise<Bounds> {
  const root = canonical(cwd);
  // a linked worktree's `.git` is a pointer file; commits write into the main
  // repo's .git/worktrees/<name>, which must stay writable or git breaks
  const common = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const gitDirRaw = common.ok && common.out ? canonical(common.out) : null;
  const gitDir = gitDirRaw && !within(gitDirRaw, root) ? gitDirRaw : null;
  // the per-user temp directory as well as /tmp: on macOS it is /var/folders/…, where tools write
  const temp = ["/tmp", resolve(tmpdir())];
  const allowWrite = uniq([root, ...(gitDir ? [gitDir] : []), ...temp, ...CACHE_DIRS].flatMap(withCanonical));
  const denyRead = uniq(secrets.flatMap(withCanonical));
  const denyWrite = uniq([...AGENT_SETTINGS.map((s) => resolve(root, s)), ...denyRead]);
  return { root, allowWrite, denyWrite, denyRead, gitDir };
}

/** The bounds for an agent started in `cwd`, once its own setup has run. Every launch comes through
 * here, a worktree's chat and a throwaway probe alike, so no agent starts with less. */
export async function prepareLaunch(cwd: string, spec: AgentSpec): Promise<Prepared> {
  const bounds = await worktreeBounds(cwd);
  const setup = await spec.setup?.(cwd, bounds);
  if (spec.confinement === "none") log.warn(cwd, `agent ${spec.id} runs without an OS sandbox`);
  return { bounds, env: setup?.env ?? {} };
}

export const SETTINGS_REL = join(".claude", "settings.local.json");

/** the settings toyon owns; anything else in the file is the user's and left alone */
export function claudeLocalSettings(b: Bounds): {
  sandbox: unknown;
  permissions: { defaultMode: string; deny: string[] };
} {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      // off, so a sandboxed command still asks and the ask reaches the policy: in `auto` the policy
      // allows it at once, in `ask` it is a card. On, Claude would run it without telling anyone,
      // and the worktree's mode would mean nothing for commands.
      autoAllowBashIfSandboxed: false,
      filesystem: { allowWrite: b.allowWrite, denyWrite: b.denyWrite, denyRead: b.denyRead },
      network: { allowLocalBinding: true },
    },
    // "default" so every Edit/Write reaches the permission policy; bypass would skip it
    permissions: { defaultMode: "default", deny: claudeDenyRules() },
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
  // the user's own deny list stays, ours is added to it; a rewrite never duplicates a rule
  const theirs = Array.isArray(perms.deny) ? (perms.deny as unknown[]).filter((r) => typeof r === "string") : [];
  const deny = uniq([...(theirs as string[]), ...ours.permissions.deny]);
  const next = { ...existing, sandbox: ours.sandbox, permissions: { ...perms, ...ours.permissions, deny } };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  // the scratch directory an agent runs in with no worktree is no repository: nothing to exclude from
  if (existsSync(join(cwd, ".git"))) await excludeFromGit(cwd, SETTINGS_REL);
}
