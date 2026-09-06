import { resolve } from "node:path";
import { canonical, within } from "../agent/bounds.ts";
import { UserError } from "../core/errors.ts";

/**
 * Resolve a client-supplied relative path to an absolute path that is guaranteed to sit inside
 * the worktree. Symlink-safe: both sides are canonicalised on their deepest existing ancestor, so
 * a link inside the tree that points elsewhere is rejected (same rule the agent sandbox uses).
 * Every daemon handler that touches the filesystem with a path from a message goes through here.
 */
export function resolveInside(worktreePath: string, rel: string, opts: { allowRoot?: boolean } = {}): string {
  if (typeof rel !== "string" || rel.includes("\0")) throw new UserError("invalid path");
  const root = canonical(resolve(worktreePath));
  const target = canonical(resolve(worktreePath, rel));
  if (target === root) {
    if (opts.allowRoot) return target;
    throw new UserError("path escapes worktree");
  }
  if (!within(target, root)) throw new UserError("path escapes worktree");
  return target;
}
