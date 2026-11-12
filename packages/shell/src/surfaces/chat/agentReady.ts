import type { AgentInfo } from "@toyon/shared";
import { installVerb, notReady } from "../../state/actions/agent.ts";

/** What the composer says, above the knobs that name the agent, while that agent cannot take the
 * message (the download under way, or why the last one did not land, with the way out) or is
 * installed but found short of a login or a provider the last time the daemon looked. It stands
 * before the send, where the hands are, because the daemon's refusal after it would come with
 * nothing to press. */
export interface AgentReadiness {
  kind: "installing" | "failed" | "unready";
  text: string;
  /** the verb that fetches the adapter, after a failure only (`install anyway` where a rule of
   * the machine's held it, which an agent still running on an older adapter offers too); null
   * where the daemon says no install would change anything (no build for this machine, a sandbox
   * that cannot start) */
  retry: "install" | "install again" | "install anyway" | null;
  /** an agent that can run instead, named only while the agent is still being chosen: a
   * worktree's agent is fixed at birth. A download in flight can be sidestepped the same way. */
  other?: AgentInfo;
}

export function agentReadiness(
  agent: AgentInfo | undefined,
  agents: AgentInfo[],
  choosing: boolean,
): AgentReadiness | null {
  if (!agent) return null;
  // installed and runnable, but short of a login (it said so itself) or of whatever its last look
  // found missing: said here, and the send still goes, since the daemon's refusal is what raises
  // the login card
  if (agent.available) {
    if (agent.checkFailed) return { kind: "unready", text: agent.checkFailed, retry: null };
    if (agent.auth?.kind === "none") {
      return { kind: "unready", text: agent.loginHint ?? `${agent.name} is not logged in`, retry: null };
    }
    // an upgrade a rule of the machine's holds: the older adapter takes the message, so this blocks
    // nothing, but only a press gets past the rule and this is where the hands are. One that merely
    // failed is fetched again by the daemon and stays on the agent's page.
    if (typeof agent.install === "object" && agent.install.held && agent.install.behind) {
      // one line at the composer's width: the version that answers meanwhile is on the agent's page
      const text = `${agent.name} ${agent.install.behind.pinned} is held back on this machine`;
      return { kind: "unready", text, retry: installVerb(agent) };
    }
    return null;
  }
  const other = choosing ? agents.find((a) => a.available && a.id !== agent.id) : undefined;
  const rest = other ? { other } : {};
  if (agent.installing) return { kind: "installing", text: `${agent.name} is installing`, retry: null, ...rest };
  const text =
    typeof agent.install === "object"
      ? `${agent.name} did not install: ${agent.install.failed}`
      : `${agent.name} is not ready: ${notReady(agent)}`;
  return { kind: "failed", text, retry: installVerb(agent), ...rest };
}
