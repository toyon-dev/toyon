// Answers an agent's session/request_permission. The bounds come first in every mode: a write
// outside the worktree is rejected, and the reason is written into the transcript for the person,
// since ACP's response carries an outcome and no reason for the agent. Inside them the worktree's mode
// decides: `auto` allows writes and sandboxed commands, `ask` (and `plan`, should a write arrive
// in it) turns each into a card for a person. A plan approval, `switch_mode` (Claude's
// ExitPlanMode, Codex's plan review), is a card in every mode: approving a plan nobody read is not
// a decision toyon can make. An agent with no OS sandbox of any kind has nothing under its commands,
// so each one is a card even in `auto`; and toyon's own secrets are refused to every tool, reads
// included.

import { isAbsolute, resolve } from "node:path";
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PermissionMode } from "@toyon/shared";
import { canonical, within } from "./bounds.ts";
import type { Bounds } from "./sandbox.ts";

export type Verdict =
  | { kind: "allow" }
  | { kind: "reject"; tool: string; path: string; reason: string }
  | { kind: "prompt" };

/** tool kinds that never write through the file tools; their side effects are the sandbox's job */
const NON_WRITE_KINDS = new Set(["execute", "read", "search", "fetch", "think"]);

/** every path the request names: ACP locations first, then the raw tool input's usual keys */
export function requestedPaths(req: RequestPermissionRequest): string[] {
  const raw: string[] = [];
  for (const loc of req.toolCall.locations ?? []) if (typeof loc.path === "string") raw.push(loc.path);
  const input = req.toolCall.rawInput;
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    // Claude says file_path, OpenCode filepath
    for (const k of ["file_path", "filepath", "filePath", "notebook_path", "path"]) {
      if (typeof rec[k] === "string") raw.push(rec[k] as string);
    }
    if (Array.isArray(rec.paths)) for (const p of rec.paths) if (typeof p === "string") raw.push(p);
  }
  return [...new Set(raw)];
}

export function decide(
  req: RequestPermissionRequest,
  bounds: Bounds,
  cwd: string,
  mode: PermissionMode = "auto",
  /** the agent's commands run inside an OS sandbox; without one, a person sees each command */
  sandboxed = true,
): Verdict {
  const tool = req.toolCall.name ?? req.toolCall.title ?? "tool";
  const paths = requestedPaths(req);
  const kind = req.toolCall.kind;
  const commandAsks = kind === "execute" && !sandboxed;
  // Claude's ExitPlanMode arrives here: a plan to read and a set of "yes, and…" options. Allowing
  // it would approve the plan and start the edits without anyone having seen it, so it is the one
  // request a person answers in every mode.
  if (kind === "switch_mode") return { kind: "prompt" };
  // in ask, what is inside the bounds is still a person's call; the bounds are checked first so an
  // outside write is a refusal with a reason, never a card offering to allow it
  const asks = mode !== "auto";
  if (paths.length === 0) {
    if (kind === "execute") return asks || commandAsks ? { kind: "prompt" } : { kind: "allow" };
    if (kind && NON_WRITE_KINDS.has(kind)) return { kind: "allow" };
    if (kind === "edit" || kind === "delete" || kind === "move") {
      return {
        kind: "reject",
        tool,
        path: "",
        reason: "The call named no file path, so Toyon cannot tell whether it stays inside the worktree.",
      };
    }
    return { kind: "allow" };
  }
  for (const raw of paths) {
    const target = canonical(isAbsolute(raw) ? raw : resolve(cwd, raw));
    if (bounds.denyRead.some((d) => within(target, d))) {
      return {
        kind: "reject",
        tool,
        path: raw,
        reason: "The file holds Toyon's own credentials, which no agent reads or writes.",
      };
    }
    if (bounds.denyWrite.some((d) => within(target, d))) {
      return {
        kind: "reject",
        tool,
        path: raw,
        reason: "Agent settings are managed by Toyon, not written by the agent.",
      };
    }
    // reads are open everywhere but the secrets, as they are in the OS sandbox, and a command's paths
    // are that sandbox's to confine; only a file tool that writes is held to allowWrite here
    if (kind && NON_WRITE_KINDS.has(kind)) continue;
    if (!bounds.allowWrite.some((a) => within(target, a))) {
      return {
        kind: "reject",
        tool,
        path: raw,
        reason: "The path is outside this worktree; Toyon confines every edit to it.",
      };
    }
  }
  // a read that names a path (Claude's Read, a search scoped to a directory) is never a card
  if (kind && NON_WRITE_KINDS.has(kind) && kind !== "execute") return { kind: "allow" };
  return asks || commandAsks ? { kind: "prompt" } : { kind: "allow" };
}

/** the rules with nobody to ask. A side session (naming, planning, a recap) has no chat to draw a
 * card in and is only ever asked to read, so it runs as `plan`: a read inside the bounds passes,
 * and anything that would have been a card is refused quietly rather than shown to anyone. */
export function decideUnattended(
  req: RequestPermissionRequest,
  bounds: Bounds,
  cwd: string,
): RequestPermissionResponse {
  const verdict = decide(req, bounds, cwd, "plan");
  if (verdict.kind !== "prompt") return pickOption(req.options, verdict);
  const tool = req.toolCall.name ?? req.toolCall.title ?? "tool";
  return pickOption(req.options, { kind: "reject", tool, path: "", reason: "nobody is watching this session" });
}

/** the option that carries the verdict: allow_once (never allow_always, which would persist a
 * rule and widen the agent's own permissions), or a reject that does not cancel the turn when the
 * agent offers one.
 *
 * `prompt` is excluded on purpose. It has no option to pick, and the `else` below would answer it
 * as a reject, so a caller that forgets to hold it open gets a type error instead of an agent
 * that is silently denied. */
export function pickOption(
  options: PermissionOption[],
  verdict: Exclude<Verdict, { kind: "prompt" }>,
): RequestPermissionResponse {
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
