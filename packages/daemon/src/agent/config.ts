// What an agent reads from disk, described for settings: the config files it looks at and the
// MCP servers those files declare. Read-only on purpose. The files are the person's, written by
// the agent's own CLI or their editor, and toyon showing them is what answers "does my setup come
// along" without toyon becoming a second writer of the same file.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfigFile, AgentConfigInfo, McpServerInfo } from "@toyon/shared";
import { log } from "../core/log.ts";
import type { AgentSpec } from "./registry.ts";

/** the files each builtin reads. A custom agent from agents.json names none: toyon does not know
 * where it keeps its config. */
export function agentConfigFiles(spec: AgentSpec, repoPath: string | null, home = homedir()): AgentConfigFile[] {
  const file = (id: string, label: string, path: string): AgentConfigFile => ({
    id,
    label,
    path,
    exists: existsSync(path),
  });
  if (spec.id === "claude") {
    return [
      file("user-config", "user config (MCP servers, projects)", join(home, ".claude.json")),
      file("user-settings", "user settings (permissions, hooks)", join(home, ".claude", "settings.json")),
      ...(repoPath ? [file("project-mcp", "project MCP servers", join(repoPath, ".mcp.json"))] : []),
      ...(repoPath ? [file("project-settings", "project settings", join(repoPath, ".claude", "settings.json"))] : []),
    ];
  }
  if (spec.id === "codex") return [file("user-config", "config", join(home, ".codex", "config.toml"))];
  return [];
}

export function describeAgentConfig(spec: AgentSpec, repoPath: string | null, home = homedir()): AgentConfigInfo {
  const files = agentConfigFiles(spec, repoPath, home);
  const servers: McpServerInfo[] = [];
  if (spec.id === "claude") {
    const user = readJson(join(home, ".claude.json"));
    servers.push(...serversOf(user?.mcpServers, "user"));
    // the config file keeps per-project entries keyed by the project's absolute path
    if (repoPath) {
      const projects = user?.projects as Record<string, unknown> | undefined;
      const mine = projects?.[repoPath] as Record<string, unknown> | undefined;
      servers.push(...serversOf(mine?.mcpServers, "local"));
      servers.push(...serversOf(readJson(join(repoPath, ".mcp.json"))?.mcpServers, "project"));
    }
  } else if (spec.id === "codex") {
    servers.push(...codexServers(join(home, ".codex", "config.toml")));
  }
  return { agent: spec.id, files, servers };
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch (e) {
    // a file the agent's own CLI wrote that we cannot read is worth a line, not a failure
    log.warn("agent-config", `${path} is not valid JSON`, e);
    return null;
  }
}

/** Claude's shape: `{ "<name>": { command, args } | { type: "http" | "sse", url } }` */
function serversOf(raw: unknown, scope: McpServerInfo["scope"]): McpServerInfo[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).map(([name, v]) => {
    const rec = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const args = Array.isArray(rec.args) ? rec.args.filter((a): a is string => typeof a === "string") : [];
    const detail =
      typeof rec.url === "string" ? rec.url : typeof rec.command === "string" ? [rec.command, ...args].join(" ") : "";
    return { name, scope, detail };
  });
}

/** Codex's `[mcp_servers.<name>]` tables. TOML enough for names and one string field each: a
 * table header opens a server, the next header closes it, `command` and `url` inside are read. */
export function codexServers(path: string): McpServerInfo[] {
  if (!existsSync(path)) return [];
  const out: McpServerInfo[] = [];
  let current: McpServerInfo | null = null;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    const header = /^\[mcp_servers\.("?)([^\]"]+)\1\]$/.exec(line);
    if (header) {
      current = { name: header[2]!, scope: "user", detail: "" };
      out.push(current);
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (!current) continue;
    const kv = /^(command|url)\s*=\s*"([^"]*)"/.exec(line);
    if (kv) current.detail = current.detail || kv[2]!;
    const args = /^args\s*=\s*\[(.*)\]/.exec(line);
    if (args && current.detail) {
      const parts = args[1]!.match(/"([^"]*)"/g)?.map((a) => a.slice(1, -1)) ?? [];
      if (parts.length) current.detail = `${current.detail} ${parts.join(" ")}`;
    }
  }
  return out;
}
