// Answers an agent's session/request_permission without a person in the loop: file writes are
// allowed inside the worktree's bounds and rejected outside them (the agent is told why), and
// everything else is allowed because the OS sandbox already confines it. The `prompt` verdict is
// reserved for the allow/deny UI; nothing returns it yet.

import { isAbsolute, resolve } from "node:path";
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { canonical, within } from "./bounds.ts";
import type { Bounds } from "./sandbox.ts";

export type Verdict =
  | { kind: "allow" }
  | { kind: "reject"; tool: string; path: string; reason: string }
  | { kind: "prompt" };

/** tool kinds that never write through the file tools; their side effects are the sandbox's job */
const NON_WRITE_KINDS = new Set(["execute", "read", "search", "fetch", "think", "switch_mode"]);

/** every path the request names: ACP locations first, then the raw tool input's usual keys */
export function requestedPaths(req: RequestPermissionRequest, cwd: string): string[] {
  const raw: string[] = [];
  for (const loc of req.toolCall.locations ?? []) if (typeof loc.path === "string") raw.push(loc.path);
  const input = req.toolCall.rawInput;
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    for (const k of ["file_path", "notebook_path", "path"]) if (typeof rec[k] === "string") raw.push(rec[k] as string);
    if (Array.isArray(rec.paths)) for (const p of rec.paths) if (typeof p === "string") raw.push(p);
  }
  return [...new Set(raw)];
}

export function decide(req: RequestPermissionRequest, bounds: Bounds, cwd: string): Verdict {
  const tool = req.toolCall.name ?? req.toolCall.title ?? "tool";
  const paths = requestedPaths(req, cwd);
  const kind = req.toolCall.kind;
  if (paths.length === 0) {
    if (kind && NON_WRITE_KINDS.has(kind)) return { kind: "allow" };
    if (kind === "edit" || kind === "delete" || kind === "move") {
      return {
        kind: "reject",
        tool,
        path: "",
        reason: `${tool} named no file path, so Toyon cannot verify it stays inside the worktree.`,
      };
    }
    return { kind: "allow" };
  }
  for (const raw of paths) {
    const target = canonical(isAbsolute(raw) ? raw : resolve(cwd, raw));
    if (bounds.denyWrite.some((d) => within(target, d))) {
      return {
        kind: "reject",
        tool,
        path: raw,
        reason: `Writing to ${raw} is not allowed: agent settings under .claude/ are managed by Toyon.`,
      };
    }
    if (!bounds.allowWrite.some((a) => within(target, a))) {
      return {
        kind: "reject",
        tool,
        path: raw,
        reason: `Writing to ${raw} is outside this worktree (${cwd}). Toyon confines edits to the worktree; work within it.`,
      };
    }
  }
  return { kind: "allow" };
}

/** the option that carries the verdict: allow_once (never allow_always, which would persist a
 * rule and widen the agent's own permissions), or a reject that does not cancel the turn when the
 * agent offers one */
export function pickOption(options: PermissionOption[], verdict: Verdict): RequestPermissionResponse {
  const byKind = (k: PermissionOption["kind"]) => options.filter((o) => o.kind === k);
  let chosen: PermissionOption | undefined;
  if (verdict.kind === "allow") {
    chosen = byKind("allow_once")[0] ?? byKind("allow_always")[0];
  } else {
    const rejects = byKind("reject_once");
    chosen = rejects.find((o) => o.optionId !== "cancel") ?? rejects[0] ?? byKind("reject_always")[0];
  }
  return chosen
    ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
    : { outcome: { outcome: "cancelled" } };
}
