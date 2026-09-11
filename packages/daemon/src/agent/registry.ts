// Which agents toyon can run, as data. Every agent speaks ACP over stdio; an entry is a launch
// command plus how it is confined and told about the worktree. The two builtins are npm packages
// installed on demand into ~/.toyon/agents/<id> (the daemon starts fetching both at boot, so the
// app's own install stays small); a user adds any other ACP agent in ~/.toyon/agents.json (per
// machine and possibly holding keys, so not in the repo's toyon.json).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentInfo } from "@toyon/shared";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { run } from "../git/exec.ts";

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
  /** the word a model row starts with where several agents' models share one list ("Claude Fable"
   * rather than "Claude Code Fable"); `name` when absent */
  short?: string;
  builtin: boolean;
  run:
    | { kind: "npm-bin"; pkg: string; version: string; bin: string; args?: string[] }
    | { kind: "command"; command: string; args?: string[] };
  env?: Record<string, string>;
  confinement: Confinement;
  /** `_meta.systemPrompt` on session/new, or SYSTEM_APPEND prepended to a session's first prompt */
  systemPrompt: "meta-append" | "prompt-prefix";
  /** session/set_mode after new/load when the agent advertises modes; the write mode */
  mode?: string;
  /** the agent's ids for toyon's plan and build modes (agent/modes.ts); guessed from the
   * advertised list when absent */
  modes?: { plan?: string; build?: string };
  /** `_meta` on session/new for a side session (a question toyon asks for itself): whatever this
   * adapter needs to run one bare, without the chat's tools or a saved conversation */
  sideMeta?: Record<string, unknown>;
  /** what the person reads when the agent answers a prompt with "not logged in" and offers no way in */
  loginHint: string;
}

export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    short: "Claude",
    builtin: true,
    run: { kind: "npm-bin", pkg: "@agentclientprotocol/claude-agent-acp", version: "0.75.1", bin: "claude-agent-acp" },
    confinement: "claude-settings",
    systemPrompt: "meta-append",
    // "default" is Claude's ask-before-changes mode: every write and command reaches the policy,
    // which is what lets toyon decide. Its own "auto" would decide without us.
    modes: { plan: "plan", build: "default" },
    // spread into the SDK's query options: without `tools` every side question carries the whole
    // tool preset's definitions, and without `persistSession` each one is saved under
    // ~/.claude/projects and listed by `claude --resume` in the worktree
    sideMeta: { claudeCode: { options: { tools: [], persistSession: false } } },
    loginHint: "Claude is not logged in",
  },
  {
    id: "codex",
    name: "Codex",
    builtin: true,
    run: { kind: "npm-bin", pkg: "@agentclientprotocol/codex-acp", version: "1.10.0", bin: "codex-acp" },
    // "agent" is Codex's workspace-write mode: its own OS sandbox around every shell command.
    // No browser in the cloud: the login method that opens one would hang there.
    env: { INITIAL_AGENT_MODE: "agent", ...(cloud.enabled ? { NO_BROWSER: "1" } : {}) },
    confinement: "adapter-sandbox",
    systemPrompt: "prompt-prefix",
    mode: "agent",
    modes: { plan: "read-only", build: "agent" },
    loginHint: "Codex is not logged in",
  },
];

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** installs `pkg@version` into `dir` (a package.json is already there); tests fake it */
export type Installer = (dir: string, pkg: string, version: string) => Promise<{ ok: boolean; err: string }>;

const bunInstall: Installer = async (dir) => {
  const r = await run(process.execPath, ["install", "--no-progress", "--no-summary"], dir);
  return { ok: r.ok, err: r.err.split("\n").slice(-3).join(" ") };
};

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
  private installing = new Map<string, Promise<void>>();
  private installErrors = new Map<string, string>();
  /** the shell wants to know when availability changes (install started, landed, failed) */
  onChange: (() => void) | null = null;

  constructor(
    specs: AgentSpec[],
    private dir: string,
    private installer: Installer = bunInstall,
  ) {
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
    if (why) throw new UserError(`${spec.name} is not ready: ${why}`);
    return spec;
  }

  /** the script an installed npm adapter's `bin` entry points at, or null */
  private npmBin(spec: AgentSpec): string | null {
    if (spec.run.kind !== "npm-bin") return null;
    const pkgJson = join(this.dir, spec.id, "node_modules", spec.run.pkg, "package.json");
    if (!existsSync(pkgJson)) return null;
    try {
      const meta = JSON.parse(readFileSync(pkgJson, "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof meta.bin === "string" ? meta.bin : meta.bin?.[spec.run.bin];
      if (!rel) return null;
      const script = join(dirname(pkgJson), rel);
      return existsSync(script) ? script : null;
    } catch (e) {
      log.warn("agents", `cannot read ${pkgJson}`, e);
      return null;
    }
  }

  /** null when launchable, else the reason it is not */
  unavailable(spec: AgentSpec): string | null {
    if (spec.run.kind === "npm-bin") {
      if (this.npmBin(spec)) return null;
      if (this.installing.has(spec.id)) return "installing";
      return this.installErrors.get(spec.id) ?? "not installed yet";
    }
    const cmd = spec.run.command;
    if (isAbsolute(cmd) ? existsSync(cmd) : Bun.which(cmd)) return null;
    return `${cmd} not found on PATH`;
  }

  launch(spec: AgentSpec): Launch {
    const why = this.unavailable(spec);
    if (why) throw new UserError(`${spec.name} is not ready: ${why}`);
    const env = { ...spec.env };
    if (spec.run.kind === "npm-bin") {
      return { command: jsRuntime(), args: [this.npmBin(spec)!, ...(spec.run.args ?? [])], env };
    }
    return { command: spec.run.command, args: [...(spec.run.args ?? [])], env };
  }

  /** Install (or upgrade) an npm adapter into its own directory. Idempotent; concurrent calls share
   * one install. Resolves when done; failures are remembered as the unavailable reason. */
  install(id: string): Promise<void> {
    const spec = this.specs.get(id);
    if (!spec) throw new UserError(`unknown agent "${id}"`);
    if (spec.run.kind !== "npm-bin") return Promise.resolve();
    const running = this.installing.get(id);
    if (running) return running;
    if (this.npmBin(spec) && this.installedVersion(spec) === spec.run.version) return Promise.resolve();
    const { pkg, version } = spec.run;
    const dir = join(this.dir, id);
    const p = (async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify({ name: `toyon-agent-${id}`, private: true, dependencies: { [pkg]: version } }, null, 2)}\n`,
      );
      log.info("agents", `installing ${pkg}@${version} for ${id}`);
      const r = await this.installer(dir, pkg, version);
      if (r.ok && this.npmBin(spec)) {
        this.installErrors.delete(id);
        log.info("agents", `${id} ready`);
      } else {
        const why = `install failed: ${r.err || "no bin after install"}`;
        this.installErrors.set(id, why);
        log.warn("agents", `${id}: ${why}`);
      }
    })().finally(() => {
      this.installing.delete(id);
      this.onChange?.();
    });
    this.installing.set(id, p);
    this.onChange?.();
    return p;
  }

  private installedVersion(spec: AgentSpec): string | null {
    if (spec.run.kind !== "npm-bin") return null;
    const pkgJson = join(this.dir, spec.id, "node_modules", spec.run.pkg, "package.json");
    try {
      return (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string }).version ?? null;
    } catch {
      // missing or unreadable: install() treats it as not installed
      return null;
    }
  }

  /** boot: fetch every builtin that is missing or on another version, one at a time, default first */
  async installMissing(order: string[] = ["claude", "codex"]): Promise<void> {
    for (const id of order) {
      const spec = this.specs.get(id);
      if (spec?.run.kind !== "npm-bin") continue;
      await this.install(id);
    }
  }

  infos(): AgentInfo[] {
    return this.list().map((spec) => {
      const reason = this.unavailable(spec);
      return {
        id: spec.id,
        name: spec.name,
        ...(spec.short ? { short: spec.short } : {}),
        available: !reason,
        ...(reason ? { reason } : {}),
        ...(this.installing.has(spec.id) ? { installing: true } : {}),
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
      ...(str("planMode") ? { modes: { plan: str("planMode"), build: str("mode") } } : {}),
      loginHint: str("loginHint") ?? `${str("name") ?? id} is not logged in`,
    });
  }
  return out;
}

/** builtins plus the user's file; a custom entry may shadow a builtin id on purpose */
export function loadAgentRegistry(home: string, agentsDir: string): AgentRegistry {
  const file = join(home, "agents.json");
  const custom = existsSync(file) ? parseCustomAgents(readFileSync(file, "utf8")) : [];
  return new AgentRegistry([...BUILTIN_AGENTS, ...custom], agentsDir);
}
