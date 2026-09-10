import type { AgentConfigFile, McpServerInfo } from "@toyon/shared";
import { useEffect } from "react";
import { agentItems } from "../../state/actions/agent.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActiveRepo } from "../../state/selectors.ts";
import { ListPicker } from "../../ui/ListPicker.tsx";
import { byName } from "./commands.ts";
import { authLabel, authTip } from "./KeysHelp.tsx";
import { PaletteRow } from "./PaletteRow.tsx";

/** the rows of one agent's page, in the order they read: who it is, what can be done about that,
 * what it will load, and where all of it is written */
type Row =
  | { kind: "identity"; label: string; hint: string }
  | { kind: "action"; id: string; label: string; danger?: boolean; run: () => void }
  | { kind: "note"; label: string }
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
  useEffect(() => {
    sock?.send({ t: "agent-config", agent: agentId, ...(repo ? { repoId: repo.id } : {}) });
  }, [sock, agentId, repo]);
  if (!agent) return null;

  const rows: Row[] = [{ kind: "identity", label: agent.name, hint: authTip(agent) }];
  for (const item of agentItems(agent, { sock, dispatch })) {
    rows.push({ kind: "action", id: item.id, label: item.label, danger: item.danger, run: item.onClick });
  }
  if (config) {
    rows.push({
      kind: "note",
      label: config.servers.length ? "MCP servers it will load" : "no MCP servers configured",
    });
    for (const s of config.servers) rows.push({ kind: "server", s });
    if (config.files.length) rows.push({ kind: "note", label: "its files; enter reveals one in Finder" });
    for (const f of config.files) rows.push({ kind: "file", f });
  }
  const reveal = (f: AgentConfigFile) =>
    sock?.send({ t: "reveal-agent-file", agent: agentId, file: f.id, ...(repo ? { repoId: repo.id } : {}) });

  return (
    <ListPicker
      items={rows}
      filter={(rs, q) =>
        q.trim()
          ? rs.filter((r) => r.kind === "server" && byName(q, r.s.name, r.s.detail)) // search finds servers
          : rs
      }
      keyOf={keyOf}
      rowClass={(r) => (r.kind === "note" ? "picker-row picker-note" : "picker-row")}
      initialIndex={() => 0}
      onPick={(r) => {
        if (r.kind === "action") r.run();
        else if (r.kind === "file" && r.f.exists) reveal(r.f);
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder={`${agent.name}: find an MCP server`}
      keys={{ pick: "acts", back: "closes" }}
      row={(r) => {
        switch (r.kind) {
          case "identity":
            return <PaletteRow label={authLabel(agent)} hint={r.hint} />;
          case "action":
            return <PaletteRow label={<span className={r.danger ? "danger" : undefined}>{r.label}</span>} />;
          case "note":
            return <PaletteRow label={<span className="row-dim">{r.label}</span>} />;
          case "server":
            return <PaletteRow label={r.s.name} hint={`${r.s.scope}${r.s.detail ? ` · ${r.s.detail}` : ""}`} />;
          case "file":
            return <PaletteRow label={r.f.label} hint={r.f.exists ? r.f.path : "not present"} />;
        }
      }}
    />
  );
}
