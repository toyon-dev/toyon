import type { AgentInfo } from "@toyon/shared";
import { installVerb, notReady } from "../../state/actions/agent.ts";

/** What the composer says, above the knobs that name the agent, while that agent cannot take the
 * message: the download under way, or why the last one did not land, with the way out. It stands
 * before the send, where the hands are, because the daemon's refusal after it would come with
 * nothing to press. */
export interface AgentReadiness {
  kind: "installing" | "failed";
  text: string;
  /** the verb that fetches the adapter, after a failure only; null where the daemon says no
   * install would change anything (no build for this machine, a sandbox that cannot start) */
  retry: "install" | "install again" | null;
  /** an agent that can run instead, named only while the agent is still being chosen: a
   * worktree's agent is fixed at birth. A download in flight can be sidestepped the same way. */
  other?: AgentInfo;
}

export function agentReadiness(
  agent: AgentInfo | undefined,
  agents: AgentInfo[],
  choosing: boolean,
): AgentReadiness | null {
  if (!agent || agent.available) return null;
  const other = choosing ? agents.find((a) => a.available && a.id !== agent.id) : undefined;
  const rest = other ? { other } : {};
  if (agent.installing) return { kind: "installing", text: `${agent.name} is installing`, retry: null, ...rest };
  const text =
    typeof agent.install === "object"
      ? `${agent.name} did not install: ${agent.install.failed}`
      : `${agent.name} is not ready: ${notReady(agent)}`;
  return { kind: "failed", text, retry: installVerb(agent), ...rest };
}
