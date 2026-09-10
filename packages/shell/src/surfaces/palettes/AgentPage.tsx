import type { AgentConfigFile, McpServerInfo } from "@toyon/shared";
import { useEffect } from "react";
import { agentItems } from "../../state/actions/agent.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActiveRepo } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu } from "../../ui/menu.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { authLabel, authTip } from "./KeysHelp.tsx";

/** One agent, as settings sees it: the card the agent's chip opens, in the settings card's own
 * shape, so a row with a chip does something and a row without one is a fact. Escape comes back
 * to the settings card. Everything here is read off disk by the daemon on open; nothing writes,
 * because the files are the agent's own CLI's. */
export function AgentPage({ agentId }: { agentId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repo = useActiveRepo();
  const home = useStore((s) => s.home);
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId) ?? null);
  const config = useStore((s) => s.agentConfigs[agentId] ?? null);
  const cm = useContextMenu("keys");
  useEffect(() => {
    sock?.send({ t: "agent-config", agent: agentId, ...(repo ? { repoId: repo.id } : {}) });
  }, [sock, agentId, repo]);
  if (!agent) return null;

  const actions = agentItems(agent, { sock, dispatch });
  const back = () => dispatch({ a: "close", back: true });
  const short = (path: string) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
  const reveal = (f: AgentConfigFile) =>
    sock?.send({ t: "reveal-agent-file", agent: agentId, file: f.id, ...(repo ? { repoId: repo.id } : {}) });

  return (
    <Overlay bare boxClass="keys-stack" onClose={back}>
      <div className="keys-card keys-settings">
        <div className="agent-page-back">
          {/* the way back, for the hand on the mouse; Escape does the same */}
          <Button tone="quiet" size="sm" onClick={back} {...tip("back to settings", "esc")}>
            <Icon name="back" className="icon-inline" /> settings
          </Button>
        </div>
        <div className="agent-page-title">{agent.name}</div>
        <div className="keys-setting">
          <span className="keys-d">signed in</span>
          {/* the chip carries the actions on the identity when there are any; a bare value otherwise */}
          <Button
            variant="field"
            mono
            data-tip={authTip(agent)}
            disabled={actions.length === 0}
            {...cm.dropdown(() => actions, "right")}
          >
            {authLabel(agent)}
          </Button>
        </div>

        <div className="section-title keys-h">MCP servers it will load</div>
        {config === null ? (
          <div className="keys-setting">
            <span className="keys-d">reading…</span>
          </div>
        ) : config.servers.length === 0 ? (
          <div className="keys-setting">
            <span className="keys-d">none configured</span>
            <span className="keys-d">add one with the agent's own CLI, or a .mcp.json in the repo</span>
          </div>
        ) : (
          config.servers.map((s) => <ServerRow key={`${s.scope}:${s.name}`} s={s} />)
        )}

        {config && config.files.length > 0 && (
          <>
            <div className="section-title keys-h">the files it reads</div>
            {config.files.map((f) => (
              <div className="keys-setting" key={f.id}>
                <span className="keys-d">{f.label}</span>
                {f.exists ? (
                  <Button variant="field" mono data-tip={`reveal ${short(f.path)} in Finder`} onClick={() => reveal(f)}>
                    {short(f.path)}
                  </Button>
                ) : (
                  <span className="keys-d">not present: {short(f.path)}</span>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </Overlay>
  );
}

/** a server as a fact: its name, where it is declared, and the command or URL behind it */
function ServerRow({ s }: { s: McpServerInfo }) {
  return (
    <div className="keys-setting">
      <span>{s.name}</span>
      <span className="keys-d">{s.detail ? `${s.scope} · ${s.detail}` : s.scope}</span>
    </div>
  );
}
