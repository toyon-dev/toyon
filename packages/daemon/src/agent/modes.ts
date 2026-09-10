// Toyon's permission modes against each agent's own session modes. Behaviour stays native: a
// read-only mode is the agent's, never re-enforced here. What toyon adds is the policy in
// policy.ts, which is how `auto` and `ask` differ on agents whose write mode is the same id.

import type { PermissionMode } from "@toyon/shared";
import type { AgentSpec } from "./registry.ts";

/** ids the builtin adapters and most ACP agents use for "read, do not act" */
export const READ_ONLY_MODE_IDS = ["plan", "read-only"];

/** the agent's mode id for a toyon mode, or null when the agent has no fitting one. `available`
 * is what the agent advertised on session/new; without it only the spec's own ids can answer. */
export function agentModeFor(spec: AgentSpec, mode: PermissionMode, available?: readonly string[]): string | null {
  const fits = (id: string | undefined) => (id && (!available || available.includes(id)) ? id : null);
  if (mode === "plan") {
    return fits(spec.modes?.plan) ?? READ_ONLY_MODE_IDS.map(fits).find(Boolean) ?? null;
  }
  // auto and ask share the agent's write mode; the policy tells them apart
  return fits(spec.modes?.build) ?? fits(spec.mode);
}

/** what a plan approval decides for the turns after it: Claude's ExitPlanMode offers "manually
 * approve edits" beside two auto-accept options, Codex's plan review offers a plain yes */
export function modeAfterPlan(optionName: string): PermissionMode {
  return /manual/i.test(optionName) ? "ask" : "auto";
}
