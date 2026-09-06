// Which agents toyon can run, as data. Every agent speaks ACP over stdio; an entry is a launch
// command plus how it is confined and told about the worktree. Two builtins ship; a user adds
// more in ~/.toyon/agents.json (per machine and possibly holding keys, so not in the repo's
// toyon.json).

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentInfo } from "@toyon/shared";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";

/** how shell commands the agent runs are kept inside the worktree */
export type Confinement =
  /** toyon writes a sandbox block into <wt>/.claude/settings.local.json (Claude Code reads it) */
  | "claude-settings"
  /** the adapter runs its agent under the agent's own OS sandbox */
  | "adapter-sandbox"
  /** nothing below the permission policy; the shell shows the agent as unsandboxed */
  | "none";

export interface AgentSpec {
  id: string;
  name: string;
  builtin: boolean;
  run:
    | { kind: "npm-bin"; pkg: string; bin: string; args?: string[] }
    | { kind: "command"; command: string; args?: string[] };
  env?: Record<string, string>;
  confinement: Confinement;
  /** `_meta.systemPrompt` on session/new, or SYSTEM_APPEND prepended to a session's first prompt */
  systemPrompt: "meta-append" | "prompt-prefix";
  /** session/set_mode after new/load when the agent advertises modes */
  mode?: string;
  /** what the person reads when the agent answers a prompt with "not logged in" */
  loginHint: string;
}

export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    builtin: true,
    run: { kind: "npm-bin", pkg: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" },
    confinement: "claude-settings",
    systemPrompt: "meta-append",
    loginHint:
      "Claude is not logged in: run `claude login` (or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN) and try again",
  },
  {
    id: "codex",
    name: "Codex",
    builtin: true,
    run: { kind: "npm-bin", pkg: "@agentclientprotocol/codex-acp", bin: "codex-acp" },
    // "agent" is Codex's workspace-write mode: its own OS sandbox around every shell command.
    // No browser in the cloud: the login method that opens one would hang there.
    env: { INITIAL_AGENT_MODE: "agent", ...(cloud.enabled ? { NO_BROWSER: "1" } : {}) },
    confinement: "adapter-sandbox",
    systemPrompt: "prompt-prefix",
    mode: "agent",
    loginHint: "Codex is not logged in: run `codex login` (or set OPENAI_API_KEY) and try again",
  },
];

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** the script an npm package's `bin` entry points at, or null when the package is missing */
export function resolveNpmBin(pkg: string, bin: string): string | null {
  let pkgJson: string;
  try {
    pkgJson = Bun.resolveSync(`${pkg}/package.json`, import.meta.dir);
  } catch {
    return null;
  }
  try {
    const meta = JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: string | Record<string, string> };
    const rel = typeof meta.bin === "string" ? meta.bin : meta.bin?.[bin];
    if (!rel) return null;
    const script = join(dirname(pkgJson), rel);
    return existsSync(script) ? script : null;
  } catch (e) {
    log.warn("agents", `cannot read ${pkgJson}`, e);
    return null;
  }
}

/** TOYON_ACP_RUNTIME=node runs the adapters under node instead of bun (the escape hatch if an
 * adapter trips over a bun incompatibility; the cloud image has no node, so bun is the default) */
function jsRuntime(): string {
  if (process.env.TOYON_ACP_RUNTIME === "node") {
    const node = Bun.which("node");
    if (node) return node;
    log.warn("agents", "TOYON_ACP_RUNTIME=node but no node on PATH; using bun");
  }
  return process.execPath;
}

export class AgentRegistry {
  private specs = new Map<string, AgentSpec>();

  constructor(specs: AgentSpec[]) {
    for (const s of specs) this.specs.set(s.id, s);
  }

  list(): AgentSpec[] {
    return [...this.specs.values()];
  }

  get(id: string): AgentSpec | undefined {
    return this.specs.get(id);
  }

  /** the spec, or a toast-worthy error: unknown id, or its command is not on this machine */
  require(id: string): AgentSpec {
    const spec = this.specs.get(id);
    if (!spec) throw new UserError(`unknown agent "${id}"`);
    const why = this.unavailable(spec);
    if (why) throw new UserError(`${spec.name} is not installed: ${why}`);
    return spec;
  }

  /** null when launchable, else the reason it is not */
  unavailable(spec: AgentSpec): string | null {
    if (spec.run.kind === "npm-bin") {
      return resolveNpmBin(spec.run.pkg, spec.run.bin) ? null : `${spec.run.pkg} is not installed`;
    }
    const cmd = spec.run.command;
    if (isAbsolute(cmd) ? existsSync(cmd) : Bun.which(cmd)) return null;
    return `${cmd} not found on PATH`;
  }

  launch(spec: AgentSpec): Launch {
    const why = this.unavailable(spec);
    if (why) throw new UserError(`${spec.name} is not installed: ${why}`);
    const env = { ...spec.env };
    if (spec.run.kind === "npm-bin") {
      const script = resolveNpmBin(spec.run.pkg, spec.run.bin)!;
      return { command: jsRuntime(), args: [script, ...(spec.run.args ?? [])], env };
    }
    return { command: spec.run.command, args: [...(spec.run.args ?? [])], env };
  }

  infos(): AgentInfo[] {
    return this.list().map((spec) => {
      const reason = this.unavailable(spec);
      return {
        id: spec.id,
        name: spec.name,
        available: !reason,
        ...(reason ? { reason } : {}),
        sandboxed: spec.confinement !== "none",
      };
    });
  }
}

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** ~/.toyon/agents.json: { "<id>": { name, command, args?, env?, confinement?, loginHint?, mode? } } */
export function parseCustomAgents(raw: string): AgentSpec[] {
  const out: AgentSpec[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.warn("agents", "agents.json is not valid JSON; ignoring it", e);
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("agents", "agents.json must be an object keyed by agent id; ignoring it");
    return out;
  }
  for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
    const e = (v ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof e[k] === "string" && (e[k] as string).trim() ? (e[k] as string) : undefined);
    const command = str("command");
    const why = !ID_RE.test(id)
      ? "id must be lowercase letters, digits and dashes"
      : !command
        ? 'needs a non-empty "command"'
        : e.args !== undefined && !(Array.isArray(e.args) && e.args.every((a) => typeof a === "string"))
          ? '"args" must be an array of strings'
          : e.env !== undefined &&
              !(e.env && typeof e.env === "object" && Object.values(e.env).every((x) => typeof x === "string"))
            ? '"env" must be an object of strings'
            : e.confinement !== undefined && e.confinement !== "none" && e.confinement !== "adapter-sandbox"
              ? '"confinement" must be "none" or "adapter-sandbox"'
              : null;
    if (why) {
      log.warn("agents", `agents.json: skipping "${id}": ${why}`);
      continue;
    }
    out.push({
      id,
      name: str("name") ?? id,
      builtin: false,
      run: { kind: "command", command: command!, ...(e.args ? { args: e.args as string[] } : {}) },
      ...(e.env ? { env: e.env as Record<string, string> } : {}),
      confinement: (e.confinement as Confinement | undefined) ?? "none",
      systemPrompt: "prompt-prefix",
      ...(str("mode") ? { mode: str("mode") } : {}),
      loginHint: str("loginHint") ?? `${str("name") ?? id} is not logged in; log in with its CLI and try again`,
    });
  }
  return out;
}

/** builtins plus the user's file; a custom entry may shadow a builtin id on purpose */
export function loadAgentRegistry(paths: Paths): AgentRegistry {
  const file = join(paths.home, "agents.json");
  const custom = existsSync(file) ? parseCustomAgents(readFileSync(file, "utf8")) : [];
  return new AgentRegistry([...BUILTIN_AGENTS, ...custom]);
}
