import type { AgentInfo } from "@toyon/shared";
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
  if (!a.available && !a.installing) {
    items.push({
      id: "install",
      label: "install again",
      onClick: () => sock?.send({ t: "install-agent", agent: a.id }),
    });
  }
  return items;
}
