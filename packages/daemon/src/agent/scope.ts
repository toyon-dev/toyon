// Hard scope for agent sessions. Two layers, neither of which the model can
// talk its way past:
//   1. OS sandbox (Seatbelt on macOS, bubblewrap on Linux) for everything Bash
//      spawns — writes are confined to the worktree, its git metadata, /tmp
//      and package-manager caches.
//   2. PreToolUse hook for the file tools (Edit/Write/NotebookEdit), which
//      bypass Bash and therefore the sandbox. Denies writes outside the same
//      allow-list with a reason the model can act on.
// Reads are left open: the default sandbox allows them, and blocking them
// breaks too much (global tool configs, resolved node_modules, /usr/lib).

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { HookCallbackMatcher, SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import { WRITE_TOOLS } from "@orchardist/shared";
import { git } from "../git/exec.ts";

export interface BlockedWrite {
  tool: string;
  path: string;
  reason: string;
}

export interface Scope {
  sandbox: SandboxSettings;
  hooks: Partial<Record<"PreToolUse", HookCallbackMatcher[]>>;
}

const CACHE_DIRS = [".bun", ".npm", ".cache", ".yarn", ".pnpm-store", "Library/Caches"].map((d) =>
  resolve(homedir(), d),
);

/** Resolve symlinks on the deepest existing ancestor so a link inside the
 * worktree pointing elsewhere can't smuggle a write out. */
export function canonical(p: string): string {
  let probe = p;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return p;
    tail.unshift(probe.slice(parent.length + 1));
    probe = parent;
  }
  try {
    return resolve(realpathSync(probe), ...tail);
  } catch {
    return p;
  }
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

export function buildScope(cwd: string, onBlocked: (b: BlockedWrite) => void): Scope {
  const root = canonical(cwd);
  // a linked worktree's `.git` is a pointer file; commits write into the main
  // repo's .git/worktrees/<name>, which must stay writable or git breaks
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const gitDir = common.ok && common.out ? canonical(common.out) : null;

  // canonical forms so `/tmp` (→ /private/tmp on macOS) matches resolved targets
  const allowWrite = uniq(
    [root, ...(gitDir && !within(gitDir, root) ? [gitDir] : []), "/tmp", ...CACHE_DIRS].flatMap((p) => [
      p,
      canonical(p),
    ]),
  );
  // the agent must not be able to widen its own permissions from inside
  const denyWrite = [resolve(root, ".claude")];

  const sandbox: SandboxSettings = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    filesystem: { allowWrite, denyWrite },
    network: { allowLocalBinding: true },
  };

  const guard: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse" || !WRITE_TOOLS.has(input.tool_name)) return {};
        const ti = (input.tool_input ?? {}) as Record<string, unknown>;
        const raw = (ti.file_path ?? ti.notebook_path) as string | undefined;
        if (!raw) return {};
        const target = canonical(isAbsolute(raw) ? raw : resolve(cwd, raw));
        let reason: string | null = null;
        if (denyWrite.some((d) => within(target, d))) {
          reason = `Writing to ${raw} is not allowed: agent settings under .claude/ are managed by Orchardist.`;
        } else if (!allowWrite.some((a) => within(target, a))) {
          reason = `Writing to ${raw} is outside this worktree (${cwd}). Orchardist confines edits to the worktree; work within it.`;
        }
        if (!reason) return {};
        onBlocked({ tool: input.tool_name, path: raw, reason });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
      },
    ],
  };

  return { sandbox, hooks: { PreToolUse: [guard] } };
}
