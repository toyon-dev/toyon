import type { AgentInfo } from "@toyon/shared";
import { useRef } from "react";
import { useOnChange } from "../../ui/hooks.ts";
import type { DaemonSocket } from "../../ws.ts";

/** A surface that shows whether an agent is ready has come to rest on one: ask the daemon to look
 * at it again, and ask once more each time the window regains focus while the surface is still
 * up, since the login or the provider setup it is waiting on happens in a terminal and the way
 * back is the window. Keyed on the surface's own identity, never on the answer. Whether a look is
 * worth a spawn is the daemon's call alone (a positive answer, a look in flight, the cooldown), so
 * the shell asks whenever the agent is installed and a message that finds nothing to do costs
 * nothing. */
export function useAgentCheck(sock: DaemonSocket | null, key: string | null, agent: AgentInfo | undefined): void {
  const latest = useRef(agent);
  latest.current = agent;
  useOnChange([sock, key, agent?.id], () => {
    if (!sock || !key) return;
    const ask = () => {
      const a = latest.current;
      if (a?.available) sock.send({ t: "agent-check", agent: a.id });
    };
    ask();
    window.addEventListener("focus", ask);
    return () => window.removeEventListener("focus", ask);
  });
}
