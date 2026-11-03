// Which agents toyon can run, as data. Every agent speaks ACP over stdio; an entry is a launch
// command plus how it is confined and told about the worktree. The builtins are npm packages
// installed into ~/.toyon/agents/<id>, so the app's own install stays small: Claude's and Codex's
// adapters are fetched at boot, OpenCode's native binary (large) when someone asks for it. A user
// adds any other ACP agent in ~/.toyon/agents.json (per machine and possibly holding keys, so not in
// the repo's settings). A daemon given another daemon's agents dir links an adapter from there
// instead of fetching it, while that copy is at the version pinned here; its own dir takes over the
// moment the pins part, so no daemon ever installs into another's.

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { type AgentInfo, MANAGED_DEFAULTS, type ManagedPolicy } from "@toyon/shared";
import { cloud } from "../core/cloud.ts";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { run } from "../git/exec.ts";
import { confine } from "./confine.ts";
import type { SandboxCheck } from "./linuxSandbox.ts";
import { type HostTraits, hostTraits, nativePackage } from "./native.ts";
import { opencodeEnv, opencodeQuickModel } from "./opencode.ts";
import { quickModelNamed } from "./quick.ts";
import { type Bounds, type Prepared, writeClaudeLocalSettings } from "./sandbox.ts";

/** how shell commands the agent runs are kept inside the worktree */
export type Confinement =
  /** toyon writes a sandbox block into <wt>/.claude/settings.local.json (Claude Code reads it) */
  | "claude-settings"
  /** the adapter runs its agent under the agent's own OS sandbox */
  | "adapter-sandbox"
  /** toyon starts the adapter inside its own OS sandbox (confine.ts), for an agent that brings none */
  | "toyon-sandbox"
  /** nothing below the permission policy; the shell shows the agent as unsandboxed, and every
   * command it runs is a card, even in auto */
  | "none";

const CONFINEMENTS: readonly Confinement[] = ["claude-settings", "adapter-sandbox", "toyon-sandbox", "none"];

export const DEFAULT_AGENT_ID = "claude";

export interface AgentSpec {
  id: string;
  name: string;
  /** the word a model row starts with where several agents' models share one list ("Claude Fable"
   * rather than "Claude Code Fable"); `name` when absent */
  short?: string;
  builtin: boolean;
  // an npm adapter's `forkOf` names the upstream package a fork is cut from; `version` is then the
  // upstream version with a `-toyon.N` suffix, and the pins script compares that base with upstream
  run:
    | { kind: "npm-bin"; pkg: string; version: string; bin: string; args?: string[]; forkOf?: string }
    /** a native binary shipped as one npm package per platform, `<pkg>-<os>-<arch>…` (native.ts),
     * run directly with no JS runtime; `bin` is its path inside that package */
    | { kind: "npm-native"; pkg: string; version: string; bin: string; args?: string[] }
    | { kind: "command"; command: string; args?: string[] };
  /** fetched only when someone asks for it, never at boot: a download too large to spend on every
   * machine that will not run it */
  onDemand?: boolean;
  env?: Record<string, string>;
  /** terminal login methods run with other arguments than the adapter offers, by method id: `args`
   * follow the adapter's own command line and `env` is added to the login's. `plan` marks a sign-in
   * with a consumer subscription, which a managed policy can withhold on company code. */
  terminalLogins?: Record<string, { args: string[]; env?: Record<string, string>; plan?: boolean }>;
  confinement: Confinement;
  /** directories under the home directory the agent keeps its own state in: writable inside toyon's
   * sandbox, which confines everything else to the worktree */
  stateDirs?: string[];
  /** runs before every launch, once the bounds are known: writes whatever the agent reads its limits
   * from, and says what to add to its environment */
  setup?: (cwd: string, bounds: Bounds) => Promise<{ env?: Record<string, string> } | undefined>;
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
  /** the person's own `_meta` on the chat's session/new and resume, from agents.json: ACP's
   * extension channel, which is where an adapter takes what its terminal takes as flags. Claude's
   * reads every SDK option under `claudeCode.options`: a plugin loaded from a folder, extra agents,
   * an MCP config. Toyon's own keys go over it, so the rules cannot be tuned away. */
  meta?: Record<string, unknown>;
  /** the model a side question runs on while the agent still offers it: a short question answered
   * well by the agent's smallest model should not cost what the chat's model costs. An agent whose
   * models depend on what the person logged into picks one from the offered ids instead (quick.ts). */
  quickModel?: string | ((offered: readonly string[], current?: string) => string | undefined);
  /** what the person reads when the agent answers a prompt with "not logged in" and offers no way in */
  loginHint: string;
}

export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    short: "Claude",
    builtin: true,
    // Toyon's fork of claude-agent-acp: upstream 0.99.1 plus the upstream PRs it is waiting on (#1350,
    // a client-chosen steer priority). The fork's TOYON.md holds the queue and the per-release
    // routine; the pin goes back to `forkOf` once every queued PR has landed there.
    run: {
      kind: "npm-bin",
      pkg: "@toyon-dev/claude-agent-acp",
      version: "0.99.1-toyon.1",
      forkOf: "@agentclientprotocol/claude-agent-acp",
      bin: "claude-agent-acp",
    },
    env: {
      // The adapter reads NO_BROWSER to choose its login: set, it offers the TUI's /login, which
      // prints a link and takes the pasted code; unset, `auth login` opens a browser the cloud lacks.
      ...(cloud.enabled ? { NO_BROWSER: "1" } : {}),
    },
    // That login opens the whole Claude Code app for its /login: a folder trust prompt, a theme
    // picker, and a session left running once it is done. `auth login` is the same Anthropic flow
    // alone, the link and the pasted code, and it exits, which is how toyon knows it finished.
    // The method id and these arguments are claude-agent-acp's at the version pinned above.
    terminalLogins: {
      "claude-login": { args: ["--cli", "auth", "login", "--claudeai"], env: { NO_BROWSER: "1" }, plan: true },
    },
    confinement: "claude-settings",
    setup: (cwd, bounds) => writeClaudeLocalSettings(cwd, bounds).then(() => undefined),
    systemPrompt: "meta-append",
    // "default" is Claude's ask-before-changes mode: every write and command reaches the policy,
    // which is what lets toyon decide. Its own "auto" would decide without us.
    modes: { plan: "plan", build: "default" },
    // spread into the SDK's query options: without `tools` every side question carries the whole
    // tool preset's definitions, and without `persistSession` each one is saved under
    // ~/.claude/projects and listed by `claude --resume` in the worktree
    sideMeta: { claudeCode: { options: { tools: [], persistSession: false } } },
    quickModel: quickModelNamed("haiku"),
    loginHint: "Claude is not logged in",
  },
  {
    id: "codex",
    name: "Codex",
    builtin: true,
    run: { kind: "npm-bin", pkg: "@agentclientprotocol/codex-acp", version: "2.5.0", bin: "codex-acp" },
    // "agent" is Codex's workspace-write mode: its own OS sandbox around every shell command.
    // No browser in the cloud: the login method that opens one would hang there.
    // CODEX_CONFIG is merged into every thread's config by the adapter. Codex lists its
    // request_user_input tool outside plan mode only behind this feature, and without the tool a
    // question that needs a yes ends the turn as prose; with it the ask comes over ACP as a form
    // and blocks until answered (autoResolutionMs null, adapter 2.5.0).
    env: {
      INITIAL_AGENT_MODE: "agent",
      CODEX_CONFIG: JSON.stringify({ features: { default_mode_request_user_input: true } }),
      ...(cloud.enabled ? { NO_BROWSER: "1" } : {}),
    },
    confinement: "adapter-sandbox",
    systemPrompt: "prompt-prefix",
    mode: "agent",
    modes: { plan: "read-only", build: "agent" },
    quickModel: "gpt-5.6-luna",
    loginHint: "Codex is not logged in",
  },
  {
    id: "opencode",
    name: "OpenCode",
    builtin: true,
    run: { kind: "npm-native", pkg: "opencode", version: "1.19.5", bin: "bin/opencode", args: ["acp"] },
    onDemand: true,
    // OpenCode brings no OS sandbox, so it runs inside toyon's, writing only the worktree and its own state
    confinement: "toyon-sandbox",
    stateDirs: [".local/share/opencode", ".local/state/opencode", ".cache/opencode"],
    // on its own OpenCode allows every edit and command; this puts them in front of toyon's policy
    setup: async () => ({ env: opencodeEnv() }),
    systemPrompt: "prompt-prefix",
    modes: { plan: "plan", build: "build" },
    quickModel: opencodeQuickModel,
    loginHint: "OpenCode has no provider logged in; run opencode auth login in the terminal",
  },
];

export interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AdapterVersion {
  id: string;
  /** null while nothing is installed */
  installed: string | null;
  pinned: string;
  /** why the last install did not land */
  error?: string;
  /** a rule of the machine's held it, which only the person's press sets aside */
  held?: true;
}

/** installs `pkg@version` into `dir` (a package.json is already there), `err` as one line; tests
 * fake it. `pastAge` runs it with bun's minimum release age off: a person's press, never the
 * daemon's own idea, since the rule is a supply chain guard of the machine's. */
export type Installer = (
  dir: string,
  pkg: string,
  version: string,
  opts?: { pastAge?: boolean },
) => Promise<{ ok: boolean; err: string }>;

/** What a failed `bun install` printed, as one line: bun's first `error:` line (the cause; the
 * ones after it only say the package then failed to resolve), or the last line when it named
 * none. */
export function installErrorLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines
    .find((l) => l.startsWith("error:"))
    ?.slice("error:".length)
    .trim();
  return first || lines.at(-1) || "no output";
}

/** The failed line with the way out, where there is one a person can take. A certificate bun
 * cannot chain to a root it trusts is nearly always a proxy's, and bun reads NODE_EXTRA_CA_CERTS
 * for it, so those codes say so; an expired or mismatched one is the registry's problem and no CA
 * file helps. A version younger than ~/.bunfig.toml's minimumReleaseAge is `held`: the rule is
 * the person's to set aside, so the shell offers the install past it instead of a plain retry. */
export function explainInstallError(line: string): { text: string; held?: true } {
  if (UNTRUSTED_CA.test(line)) {
    return {
      text: `${line}. A certificate bun does not trust, usually a proxy's: set NODE_EXTRA_CA_CERTS to its file and restart Toyon`,
    };
  }
  if (AGE_BLOCK.test(line)) {
    return {
      text: `${line}. bun's minimumReleaseAge rule in ~/.bunfig.toml holds this version back: wait it out, or install anyway to set the rule aside for this download`,
      held: true,
    };
  }
  return { text: line };
}

/** the host that answered bun's `GET <url> - 404` when it is not npm's own: a company mirror that
 * does not carry the package, which the public registry does */
export function mirrorWithout(line: string): string | null {
  const m = MIRROR_404.exec(line);
  return m?.[1] && m[1] !== PUBLIC_REGISTRY_HOST ? m[1] : null;
}

const UNTRUSTED_CA =
  /UNKNOWN_CERTIFICATE_VERIFICATION_ERROR|SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/;
const MIRROR_404 = /^GET https?:\/\/([^/\s]+)\/\S* - 404$/;
const AGE_BLOCK = /blocked by minimum-release-age/;
const PUBLIC_REGISTRY_HOST = "registry.npmjs.org";
const PUBLIC_REGISTRY = `https://${PUBLIC_REGISTRY_HOST}/`;

/** The `.npmrc` the daemon writes beside an adapter's package.json once the registry ~/.npmrc
 * names has answered 404 for it: bun reads the install directory's file over the home one, for
 * the default registry and a scope alike, so this sends the whole fetch to the public registry
 * without touching anything of the person's. The adapters are published nowhere else, so where
 * public npm is allowed this is the only way the fetch lands, and where it is blocked the retry
 * fails the same and the line says so. */
function publicRegistryRc(pkg: string): string {
  const scope = pkg.startsWith("@") ? pkg.slice(0, pkg.indexOf("/")) : null;
  return `registry=${PUBLIC_REGISTRY}\n${scope ? `${scope}:registry=${PUBLIC_REGISTRY}\n` : ""}`;
}

const bunInstall: Installer = async (dir, _pkg, _version, opts = {}) => {
  // plain output: a daemon launched from a shell that forces colour would wrap bun's `error:`
  // in escapes, and the line is read, not shown
  // its own ceiling: an adapter pulls a whole SDK, which on a slow link outlasts a git call's
  const r = await run(
    process.execPath,
    ["install", "--no-progress", "--no-summary", ...(opts.pastAge ? ["--minimum-release-age=0"] : [])],
    dir,
    { NO_COLOR: "1", FORCE_COLOR: "0" },
    { timeoutMs: 30 * 60_000 },
  );
  // stderr is read only when bun failed: a clean exit may still have warned, and that is not
  // why an adapter with no bin cannot run
  return { ok: r.ok, err: r.ok ? "" : installErrorLine(r.err) };
};

/** How long a failed install is left alone before a shell's arrival tries it again: half a minute
 * after the first failure, doubling with each one in a row up to an hour. A tab reloaded in a loop
 * must not download in one, and a failure that will not change (an air-gapped machine, a registry
 * that refuses the version) must not be fetched on every reconnect for ever; the install button
 * stays for the person who knows it has changed. */
const RETRY_AFTER_MS = 30_000;
const RETRY_CAP_MS = 60 * 60_000;
/** the wait after `retries` automatic tries have failed in a row; a press of the install button
 * is not one of them, so pressing it while offline does not push the next automatic try out */
const retryWindow = (retries: number) => Math.min(RETRY_AFTER_MS * 2 ** retries, RETRY_CAP_MS);

/** the reason an agent whose fetch failed cannot run, as the picker, doctor and log all say it */
const failedReason = (why: string) => `install failed: ${why}`;

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
  /** why the last fetch did not land, and whether a rule of the machine's held it, which the
   * person's press can set aside (`install anyway`) where a plain retry would fail the same */
  private installErrors = new Map<string, { why: string; held: boolean }>();
  /** when each remembered failure happened and how many automatic retries have failed since, so
   * a retry does not follow every reconnect and a failure that will not change is not downloaded
   * for ever */
  private failures = new Map<string, { at: number; retries: number }>();
  /** the shell wants to know when availability changes (install started, landed, failed) */
  onChange: (() => void) | null = null;

  constructor(
    specs: AgentSpec[],
    private dir: string,
    private installer: Installer = bunInstall,
    /** which native build this machine takes; read once, since the files that say do not change */
    private host: HostTraits = hostTraits(),
    /** why agent sandboxes cannot start here; the daemon passes the live Linux check */
    private sandbox: SandboxCheck = { problem: () => null },
    /** the clock the retry window is measured on; tests move it */
    private now: () => number = Date.now,
    /** another daemon's agents dir, linked from rather than fetched while its copy matches the pin */
    private borrowFrom: string | null = null,
  ) {
    for (const s of specs) this.specs.set(s.id, s);
  }

  list(): AgentSpec[] {
    return [...this.specs.values()];
  }

  /** the agent a worktree gets when nobody named one: the persisted choice while it is still
   * here, else Claude, else whatever the policy left first. A default that the policy took away
   * would otherwise be a ghost the shell shows and nothing can run. Whether it can run right now
   * is not weighed here: the composer says why it is not ready and offers the agent that is,
   * rather than the default moving under the person. */
  defaultId(persisted: string | undefined): string {
    if (persisted !== undefined && this.specs.has(persisted)) return persisted;
    if (this.specs.has(DEFAULT_AGENT_ID)) return DEFAULT_AGENT_ID;
    return this.list()[0]?.id ?? DEFAULT_AGENT_ID;
  }

  get(id: string): AgentSpec | undefined {
    return this.specs.get(id);
  }

  /** the spec, or an error worth reading: unknown id, or its command is not on this machine */
  require(id: string): AgentSpec {
    const spec = this.specs.get(id);
    if (!spec) throw new UserError(`unknown agent "${id}"`);
    const why = this.unavailable(spec);
    if (why) throw new UserError(`${spec.name} is not ready: ${why}`);
    return spec;
  }

  /** the npm package an adapter is installed from: its own, or this machine's build of a native one;
   * null for a command, or for a native agent with no build for this machine */
  private packageName(spec: AgentSpec): string | null {
    if (spec.run.kind === "npm-bin") return spec.run.pkg;
    if (spec.run.kind === "npm-native") return nativePackage(spec.run.pkg, this.host);
    return null;
  }

  /** what an installed adapter runs: the script an npm adapter's `bin` entry points at, or the
   * native binary; null while it is not installed */
  private installed(spec: AgentSpec): string | null {
    return this.installedIn(this.dir, spec);
  }

  /** the same, in any agents dir: the one this registry owns, or the one it may borrow from */
  private installedIn(base: string, spec: AgentSpec): string | null {
    const name = this.packageName(spec);
    if (!name || spec.run.kind === "command") return null;
    const pkgDir = join(base, spec.id, "node_modules", name);
    if (spec.run.kind === "npm-native") {
      const bin = join(pkgDir, spec.run.bin);
      return existsSync(bin) ? bin : null;
    }
    const pkgJson = join(pkgDir, "package.json");
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

  /** null when launchable, else the reason it is not: not installed, or a sandbox it needs cannot
   * start on this machine */
  unavailable(spec: AgentSpec): string | null {
    return this.status(spec).reason;
  }

  /** One look at the disk answers both of what the shell reads: why the agent cannot run, and
   * whether a fetch is the way out. A sandbox that cannot start is the reason whether or not the
   * adapter is on disk, since it would still stand after the download, and then no fetch is
   * offered. */
  private status(spec: AgentSpec): { reason: string | null; install?: AgentInfo["install"] } {
    const boxed = spec.confinement === "none" ? null : this.sandbox.problem();
    if (spec.run.kind === "command") {
      const cmd = spec.run.command;
      const found = isAbsolute(cmd) ? existsSync(cmd) : Bun.which(cmd);
      return { reason: found ? boxed : `${cmd} not found on PATH` };
    }
    if (!this.packageName(spec)) return { reason: `no build for ${this.host.platform} ${this.host.arch}` };
    if (this.installed(spec)) return { reason: boxed };
    // the download is the state every surface names while it runs; the sandbox takes over once it lands
    if (this.installing.has(spec.id)) return { reason: "installing" };
    const failed = this.installErrors.get(spec.id);
    const missing = failed ? failedReason(failed.why) : spec.onDemand ? "not installed" : "not installed yet";
    // what the fetch printed is still worth reading beside the sandbox: both may need fixing
    if (boxed) return { reason: failed ? `${missing}; ${boxed}` : boxed };
    return {
      reason: missing,
      install: failed ? { failed: failed.why, ...(failed.held ? { held: true } : {}) } : "missing",
    };
  }

  /** the adapter's own command line, unconfined: what a terminal login types */
  command(spec: AgentSpec): { command: string; args: string[] } {
    const why = this.unavailable(spec);
    if (why) throw new UserError(`${spec.name} is not ready: ${why}`);
    if (spec.run.kind === "npm-bin")
      return { command: jsRuntime(), args: [this.installed(spec)!, ...(spec.run.args ?? [])] };
    if (spec.run.kind === "npm-native") return { command: this.installed(spec)!, args: [...(spec.run.args ?? [])] };
    return { command: spec.run.command, args: [...(spec.run.args ?? [])] };
  }

  /** how to start the adapter once `prepareLaunch` has run: its command, inside toyon's sandbox when
   * the agent runs in it, with its setup's environment over its own */
  launch(spec: AgentSpec, prepared: Prepared): Launch {
    const base = { ...this.command(spec), env: { ...spec.env, ...prepared.env } };
    if (spec.confinement !== "toyon-sandbox") return base;
    return confine(
      base,
      prepared.bounds,
      (spec.stateDirs ?? []).map((d) => resolve(homedir(), d)),
    );
  }

  /** Install (or upgrade) an npm adapter into its own directory. Idempotent; concurrent calls share
   * one install. Resolves when done; failures are remembered as the unavailable reason. A
   * registry that does not carry the package is retried through the public one on the daemon's
   * own; `anyway` is the person's press that runs the fetch past the machine's minimum release
   * age, and is never assumed. */
  install(id: string, opts: { anyway?: boolean } = {}): Promise<void> {
    const spec = this.specs.get(id);
    if (!spec) throw new UserError(`unknown agent "${id}"`);
    const pkg = this.packageName(spec);
    if (spec.run.kind === "command" || !pkg) return Promise.resolve();
    const running = this.installing.get(id);
    // the press past the rule is not absorbed into a plain fetch already on its way (a shell's
    // reconnect retry), which would fail on the rule again with nothing to say the press was lost
    if (running) return opts.anyway ? running.then(() => this.install(id, opts)) : running;
    if (this.installed(spec) && this.installedVersion(spec) === spec.run.version) {
      // landed by another route (a script, another daemon on the same directory): a failure
      // remembered from before would otherwise be reported, and retried, for ever
      this.installErrors.delete(id);
      this.failures.delete(id);
      return Promise.resolve();
    }
    const { version } = spec.run;
    const dir = join(this.dir, id);
    const p = (async () => {
      try {
        const borrowed = await this.borrow(spec, version);
        if (borrowed) {
          this.installErrors.delete(id);
          this.failures.delete(id);
          log.info("agents", `${id} ready, linked from ${borrowed}`);
          return;
        }
        // a link left from a borrow would carry this install into the other daemon's dir
        disown(dir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          `${JSON.stringify({ name: `toyon-agent-${id}`, private: true, dependencies: { [pkg]: version } }, null, 2)}\n`,
        );
        log.info("agents", `installing ${pkg}@${version} for ${id}`);
        // every fetch starts from the person's own registry: the .npmrc a past fallback left
        // would otherwise send this one to the public registry for ever, on a network where
        // only the mirror answers now (a VPN joined since) and the mirror has since picked it up
        const rc = join(dir, ".npmrc");
        rmSync(rc, { force: true });
        const fetch = () => this.installer(dir, pkg, version, { pastAge: opts.anyway === true });
        let r = await fetch();
        let why = r.ok ? null : explainInstallError(r.err);
        const mirror = r.ok ? null : mirrorWithout(r.err);
        if (mirror) {
          // the registry ~/.npmrc names has never heard of the adapter; the public one is where it
          // is published, so the install directory's own .npmrc sends the fetch there, for this
          // fetch alone
          log.info("agents", `${mirror} does not carry ${pkg}; fetching it from the public registry`);
          writeFileSync(rc, publicRegistryRc(pkg));
          r = await fetch();
          if (!r.ok) {
            rmSync(rc, { force: true });
            const again = explainInstallError(r.err);
            why = {
              ...again,
              text: `${mirror} does not carry the package, and from the public registry: ${again.text}`,
            };
          } else why = null;
        }
        if (r.ok && this.installed(spec)) {
          this.installErrors.delete(id);
          this.failures.delete(id);
          log.info("agents", `${id} ready`);
          return;
        }
        this.fail(id, why?.text || "no bin after install", why?.held === true);
      } catch (e) {
        // a directory that cannot be written is a failure the shell shows like any other, and
        // the promise settles, so a retry loop over several agents reaches the next one
        this.fail(id, e instanceof Error ? e.message : String(e), false);
      }
    })().finally(() => {
      this.installing.delete(id);
      this.onChange?.();
    });
    this.installing.set(id, p);
    this.onChange?.();
    return p;
  }

  /** Link <dir>/<id> to the other daemon's copy when that copy runs and is at the pinned version:
   * the path of what was linked, or null when there is nothing fit to link and a fetch is the way.
   * Whatever this registry had of its own for the agent (an older fetch, a stale link) goes, since
   * the link takes its place. */
  private async borrow(spec: AgentSpec, version: string): Promise<string | null> {
    const from = this.borrowFrom;
    if (!from || resolve(from) === resolve(this.dir)) return null;
    if (!this.installedIn(from, spec) || this.installedVersionIn(from, spec) !== version) return null;
    const src = join(from, spec.id);
    const own = join(this.dir, spec.id);
    disown(own);
    await rm(own, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    await symlink(src, own);
    return src;
  }

  private fail(id: string, why: string, held: boolean): void {
    this.installErrors.set(id, { why, held });
    this.failures.set(id, { at: this.now(), retries: this.failures.get(id)?.retries ?? 0 });
    log.warn("agents", `${id}: ${failedReason(why)}`);
  }

  private installedVersion(spec: AgentSpec): string | null {
    return this.installedVersionIn(this.dir, spec);
  }

  private installedVersionIn(base: string, spec: AgentSpec): string | null {
    const name = this.packageName(spec);
    if (!name) return null;
    const pkgJson = join(base, spec.id, "node_modules", name, "package.json");
    try {
      return (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string }).version ?? null;
    } catch {
      // missing or unreadable: install() treats it as not installed
      return null;
    }
  }

  /** boot: fetch every builtin that is missing or on another version, one at a time, default first;
   * an agent fetched on demand waits for someone to ask */
  async installMissing(order: string[] = ["claude", "codex"]): Promise<void> {
    for (const id of order) {
      const spec = this.specs.get(id);
      if (!spec || spec.run.kind === "command" || spec.onDemand) continue;
      await this.install(id);
    }
  }

  /** a shell arriving: every adapter whose last install failed is fetched again, once the failure
   * is old enough. One fetched on demand failed because someone asked for it, so it is tried the
   * same. The install at boot is the only other try, so without this a network that came back (a
   * VPN joined after launch) left the agent failed until a restart. */
  async retryFailed(): Promise<void> {
    // not beside the boot's own downloads: two bun installs would share the line, and the first
    // prompt waits on both
    if (this.installing.size > 0) return;
    for (const [id, entry] of this.failures) {
      if (this.now() - entry.at < retryWindow(entry.retries)) continue;
      entry.retries += 1;
      await this.install(id);
    }
  }

  /** each npm adapter's version on disk beside the one this toyon pins, for `toyon doctor`. An
   * upgrade that fails leaves the older adapter launchable, so nothing in `infos()` shows it. An
   * agent fetched on demand is listed once someone has asked for it. */
  adapters(): AdapterVersion[] {
    const out: AdapterVersion[] = [];
    for (const spec of this.list()) {
      if (spec.run.kind === "command" || !this.packageName(spec)) continue;
      const installed = this.installed(spec) ? this.installedVersion(spec) : null;
      const failed = this.installErrors.get(spec.id);
      if (spec.onDemand && installed === null && failed === undefined) continue;
      out.push({
        id: spec.id,
        installed,
        pinned: spec.run.version,
        ...(failed ? { error: failedReason(failed.why), ...(failed.held ? { held: true } : {}) } : {}),
      });
    }
    return out;
  }

  infos(): AgentInfo[] {
    return this.list().map((spec) => {
      const { reason, install } = this.status(spec);
      return {
        id: spec.id,
        name: spec.name,
        ...(spec.short ? { short: spec.short } : {}),
        available: !reason,
        ...(reason ? { reason } : {}),
        ...(this.installing.has(spec.id) ? { installing: true } : {}),
        ...(install !== undefined ? { install } : {}),
        ...(spec.onDemand ? { onDemand: true } : {}),
        sandboxed: spec.confinement !== "none",
        loginHint: spec.loginHint,
      };
    });
  }
}

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** ~/.toyon/agents.json over the builtins: { "<id>": { name, command, args?, env?, meta?, confinement?,
 * loginHint?, mode?, planMode?, quickModel? } }. An entry with a `command` is an agent of the
 * person's own, in a builtin's place when it takes its id. An entry under a builtin's id with no
 * `command` keeps the builtin and tunes it: `env` goes over its own, `meta` rides its sessions.
 * That is where what the terminal gets from the shell or a flag reaches an agent toyon starts
 * from the Dock, with no shell in between. */
export function parseAgentsFile(raw: string, builtins: AgentSpec[]): AgentSpec[] {
  const out = [...builtins];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.warn("agents", "agents.json is not valid JSON; ignoring it", e);
    return out;
  }
  if (!isRecord(parsed)) {
    log.warn("agents", "agents.json must be an object keyed by agent id; ignoring it");
    return out;
  }
  for (const [id, v] of Object.entries(parsed)) {
    const e = (v ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof e[k] === "string" && (e[k] as string).trim() ? (e[k] as string) : undefined);
    const command = str("command");
    const at = out.findIndex((s) => s.id === id);
    const tunes = !command && at >= 0 && out[at]!.builtin;
    const why = !ID_RE.test(id)
      ? "id must be lowercase letters, digits and dashes"
      : !command && !tunes
        ? 'needs a non-empty "command" (only a builtin is tuned without one)'
        : e.args !== undefined && !(Array.isArray(e.args) && e.args.every((a) => typeof a === "string"))
          ? '"args" must be an array of strings'
          : e.env !== undefined && !(isRecord(e.env) && Object.values(e.env).every((x) => typeof x === "string"))
            ? '"env" must be an object of strings'
            : e.meta !== undefined && !isRecord(e.meta)
              ? '"meta" must be an object'
              : // claude-settings is Claude Code's settings file and nothing another agent reads
                e.confinement !== undefined &&
                  (e.confinement === "claude-settings" || !CONFINEMENTS.includes(e.confinement as Confinement))
                ? '"confinement" must be "none", "adapter-sandbox" or "toyon-sandbox"'
                : null;
    if (why) {
      log.warn("agents", `agents.json: skipping "${id}": ${why}`);
      continue;
    }
    const env = e.env as Record<string, string> | undefined;
    const meta = e.meta as Record<string, unknown> | undefined;
    if (tunes) {
      const base = out[at]!;
      out[at] = {
        ...base,
        ...(env ? { env: { ...base.env, ...env } } : {}),
        ...(meta ? { meta } : {}),
      };
      continue;
    }
    const spec: AgentSpec = {
      id,
      name: str("name") ?? id,
      builtin: false,
      run: { kind: "command", command: command!, ...(e.args ? { args: e.args as string[] } : {}) },
      ...(env ? { env } : {}),
      ...(meta ? { meta } : {}),
      confinement: (e.confinement as Confinement | undefined) ?? "none",
      systemPrompt: "prompt-prefix",
      ...(str("mode") ? { mode: str("mode") } : {}),
      ...(str("planMode") ? { modes: { plan: str("planMode"), build: str("mode") } } : {}),
      ...(str("quickModel") ? { quickModel: str("quickModel") } : {}),
      loginHint: str("loginHint") ?? `${str("name") ?? id} is not logged in`,
    };
    // in the builtin's place, so the rail's order does not depend on who shadowed what
    if (at >= 0) out[at] = spec;
    else out.push(spec);
  }
  return out;
}

/** what the managed policy says about which agents exist here */
export type ManagedAgents = Pick<ManagedPolicy, "agents" | "customAgents">;

/** the specs less what the policy withholds: every custom entry when custom agents are off, and
 * any id not on the allowlist. An allowlisted id nothing here answers to is ignored. */
export function managedSpecs(specs: AgentSpec[], managed: ManagedAgents): AgentSpec[] {
  const kept = managed.customAgents ? specs : specs.filter((s) => s.builtin);
  return managed.agents === null ? kept : kept.filter((s) => managed.agents?.includes(s.id));
}

/** builtins plus the user's file, less what the policy withholds; a custom entry may shadow a
 * builtin id on purpose, which is one of the things the policy can forbid. The whole file goes
 * with that, a tuned builtin included: a policy that keeps people from bringing an agent keeps
 * them from loading code into one as well. */
export function loadAgentRegistry(
  agentsFile: string,
  agentsDir: string,
  sandbox?: SandboxCheck,
  managed: ManagedAgents = MANAGED_DEFAULTS,
  agentsFrom: string | null = null,
): AgentRegistry {
  const specs =
    managed.customAgents && existsSync(agentsFile)
      ? parseAgentsFile(readFileSync(agentsFile, "utf8"), BUILTIN_AGENTS)
      : BUILTIN_AGENTS;
  return new AgentRegistry(
    managedSpecs(specs, managed),
    agentsDir,
    undefined,
    undefined,
    sandbox,
    undefined,
    agentsFrom,
  );
}

/** remove <dir>/<id> when it is a link, never what it points at; a real dir or nothing stays.
 * One stat, done in line: a fetch at boot has to reach the installer before the first tick. */
function disown(dir: string): void {
  // lstat, not exists: a link whose target has gone is still a link in the way of a mkdir
  if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(dir);
}
