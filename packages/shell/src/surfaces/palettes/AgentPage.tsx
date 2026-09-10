import type { AgentConfigFile, McpServerInfo } from "@toyon/shared";
import { useEffect, useMemo } from "react";
import { agentItems } from "../../state/actions/agent.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActiveRepo } from "../../state/selectors.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { byName } from "./commands.ts";
import { authLabel } from "./KeysHelp.tsx";
import { PaletteRow } from "./PaletteRow.tsx";

/** the rows of one agent's page, in the order they read: who it is, what can be done about that,
 * what it will load, and where all of it is written */
type Row =
  | { kind: "identity"; label: string; hint: string }
  | { kind: "action"; id: string; label: string; danger?: boolean; run: () => void }
  | { kind: "note"; label: string; hint: string }
  | { kind: "server"; s: McpServerInfo }
  | { kind: "file"; f: AgentConfigFile };

const keyOf = (r: Row): string =>
  r.kind === "identity"
    ? "identity"
    : r.kind === "action"
      ? `action:${r.id}`
      : r.kind === "note"
        ? `note:${r.label}`
        : r.kind === "server"
          ? `server:${r.s.scope}:${r.s.name}`
          : `file:${r.f.id}`;

/** One agent, as settings sees it: the sub-view the agent's chip opens, coming back to the
 * settings card on Escape like the theme and appearance pickers. Everything on it is read off
 * disk by the daemon on open; nothing here writes, because the files are the agent's own CLI's. */
export function AgentPage({ agentId }: { agentId: string }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const repo = useActiveRepo();
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId) ?? null);
  const config = useStore((s) => s.agentConfigs[agentId] ?? null);
  const home = useStore((s) => s.home);
  useEffect(() => {
    sock?.send({ t: "agent-config", agent: agentId, ...(repo ? { repoId: repo.id } : {}) });
  }, [sock, agentId, repo]);
  // one array per change of inputs: the picker keeps its highlight by item identity, and a list
  // rebuilt on every render would put the arrow keys back on the first row each time
  const rows = useMemo((): Row[] => {
    if (!agent) return [];
    const out: Row[] = [{ kind: "identity", label: `signed in: ${authLabel(agent)}`, hint: whoTip(agent) }];
    for (const item of agentItems(agent, { sock, dispatch })) {
      out.push({ kind: "action", id: item.id, label: item.label, danger: item.danger, run: item.onClick });
    }
    if (config) {
      out.push({
        kind: "note",
        label: config.servers.length ? "MCP servers it will load" : "no MCP servers configured",
        hint: config.servers.length ? "" : "add one with the agent's own CLI, or a .mcp.json in the repo",
      });
      for (const s of config.servers) out.push({ kind: "server", s });
      if (config.files.length) out.push({ kind: "note", label: "the files it reads", hint: "enter reveals one" });
      for (const f of config.files) out.push({ kind: "file", f });
    }
    return out;
  }, [agent, config, sock, dispatch]);
  if (!agent) return null;

  const reveal = (f: AgentConfigFile) =>
    sock?.send({ t: "reveal-agent-file", agent: agentId, file: f.id, ...(repo ? { repoId: repo.id } : {}) });
  const short = (path: string) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

  return (
    <ListPicker
      items={rows}
      filter={(rs, q) =>
        q.trim()
          ? rs.filter((r) => r.kind === "server" && byName(q, r.s.name, r.s.detail)) // search finds servers
          : rs
      }
      keyOf={keyOf}
      rowClass={(r) =>
        r.kind === "note"
          ? "picker-row picker-note"
          : r.kind === "file" && !r.f.exists
            ? "picker-row dim"
            : "picker-row"
      }
      initialIndex={() => 0}
      onPick={(r) => {
        if (r.kind === "action") r.run();
        else if (r.kind === "file" && r.f.exists) reveal(r.f);
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder={`${agent.name}: type to find an MCP server`}
      keys={{ pick: "reveals a file", back: "closes" }}
      row={(r) => {
        switch (r.kind) {
          case "identity":
            return <PaletteRow label={r.label} hint={r.hint} />;
          case "action":
            return <PaletteRow label={<span className={r.danger ? "danger" : undefined}>{r.label}</span>} />;
          case "note":
            return <PaletteRow label={<span className="row-dim">{r.label}</span>} hint={r.hint || undefined} />;
          case "server":
            return <PaletteRow label={r.s.name} hint={`${r.s.scope}${r.s.detail ? ` · ${r.s.detail}` : ""}`} />;
          case "file":
            return (
              <PaletteRow label={r.f.label} hint={r.f.exists ? short(r.f.path) : `not present: ${short(r.f.path)}`} />
            );
        }
      }}
    />
  );
}

/** the account behind the identity row, when the agent has said; the card's longer tooltip is
 * for a hover, not a row */
function whoTip(a: { auth?: { detail?: string; account?: { email?: string; organization?: string } } }): string {
  return [a.auth?.detail, a.auth?.account?.email, a.auth?.account?.organization].filter(Boolean).join(" · ");
}
