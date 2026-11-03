import type { AgentInfo, ClientMsg } from "@toyon/shared";
import type { MenuItem } from "../../ui/menu.ts";
import type { Deps } from "./deps.ts";

/** an agent in the settings card: the actions that change its login state. Logging *in* stays
 * in the chat, where the auth card can also run a method that needs the worktree's terminal. */
export function agentItems(a: AgentInfo, { sock }: Deps): MenuItem[] {
  const items: MenuItem[] = [];
  if (a.canLogout && a.auth?.kind !== "none") {
    items.push({
      id: "logout",
      label: "log out",
      danger: true,
      onClick: () => sock?.send({ t: "agent-logout", agent: a.id }),
    });
  }
  const verb = installVerb(a);
  if (verb) {
    items.push({
      id: "install",
      label: verb,
      onClick: () => sock?.send(installMsg(a)),
    });
  }
  return items;
}

/** the word that fetches an agent's adapter, the same on every surface that offers it: the first
 * fetch for one never tried, another after a failure, the one past the machine's rule where that
 * rule held the last, and nothing where the daemon says no install would help or one is already
 * on its way */
export function installVerb(a: AgentInfo): "install" | "install again" | "install anyway" | null {
  if (!a.install) return null;
  if (a.install === "missing") return "install";
  return a.install.held ? "install anyway" : "install again";
}

/** what the verb sends: `anyway` rides along only on the install past the rule */
export function installMsg(a: AgentInfo): ClientMsg {
  const anyway = installVerb(a) === "install anyway";
  return { t: "install-agent", agent: a.id, ...(anyway ? { anyway: true } : {}) };
}

/** why an agent cannot run, as every surface words it: the daemon's reason, and one default where
 * it gave none */
export const notReady = (a: AgentInfo): string => a.reason ?? "not installed";
