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

/** The adapter row on the agent's page: what is on disk against what this Toyon pins, and the
 * verb that fetches it. Null while the pinned adapter is installed, and where no install would
 * help. An older adapter that still answers is named with its version, since the agent runs and
 * nothing else on screen says the pinned one is owed; `why` is what the last fetch printed. */
export function adapterRow(
  a: AgentInfo,
): { text: string; verb: ReturnType<typeof installVerb>; why?: string; busy?: true } | null {
  if (a.installing) return { text: "adapter", verb: null, busy: true };
  const verb = installVerb(a);
  if (!verb || !a.install) return null;
  if (a.install === "missing") return { text: "adapter is not installed", verb };
  const { behind, held, failed } = a.install;
  if (!behind) return { text: "adapter did not install", verb, why: failed };
  const state = held ? "is held back" : "did not install";
  return { text: `runs adapter ${behind.runs}; ${behind.pinned} ${state}`, verb, why: failed };
}

/** why an agent cannot run, as every surface words it: the daemon's reason, and one default where
 * it gave none */
export const notReady = (a: AgentInfo): string => a.reason ?? "not installed";
