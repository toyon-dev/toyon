// What the daemon knows about each installed agent beyond what is on disk: who it is signed in
// as and which models it offers, both learned only by running it. An answer that is positive
// (models listed, no failed check, no login the agent said it lacks) is never asked for again,
// since the agent's own sessions keep it fresh. A negative one is checked again whenever someone
// is looking at it, at most once per cooldown, so a login or a provider set up outside Toyon
// shows up here without a restart. Live sessions report what they learn into the same place.

import * as acp from "@agentclientprotocol/sdk";
import type { AgentInfo, AgentLimits, AuthStatus, ModelChoice } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import {
  AUTH_STATUS_UPDATE_METHOD,
  type AuthObservation,
  isAuthRequired,
  parseAuthStatus,
  supportsLogout,
} from "./acp/authstatus.ts";
import { readOptions } from "./acp/options.ts";
import type { AcpLink } from "./acp/transport.ts";
import type { AgentSpec } from "./registry.ts";

export interface AgentReadinessDeps {
  /** the registry's view of every agent: installed, installing, why not */
  infos: () => AgentInfo[];
  /** the spec for an id, or a UserError; the registry's own `require` */
  require: (id: string) => AgentSpec;
  /** spawn the adapter for a short-lived connection with no worktree behind it, prepared like any launch */
  connect: (app: acp.ClientApp, spec: AgentSpec) => Promise<AcpLink>;
  /** where the throwaway session says it works; nothing is prompted, so nothing is written there */
  cwd: string;
  /** the choices a session listed before in a category (model, thought_level), from the state store */
  options: (agentId: string, category: string) => ModelChoice[];
  learned: (agentId: string, category: string, choices: ModelChoice[]) => void;
  /** whether the side questions can be put to it (it has a quick model) */
  quick: (agentId: string) => boolean;
  now?: () => number;
}

/** how long a negative answer stands before another look is worth a spawn */
export const CHECK_COOLDOWN_MS = 30_000;

interface Entry {
  /** the identity any connection last pushed */
  status?: AuthStatus;
  canLogout: boolean;
  limits?: AgentLimits;
  /** when the last check finished, however it ended */
  checkedAt?: number;
  /** why the last check failed; gone once one succeeds or a session sees the agent logged in */
  failure?: string;
}

export class AgentReadiness {
  private known = new Map<string, Entry>();
  /** the check or logout running on an agent, so a second look joins it instead of spawning beside it */
  private inflight = new Map<string, Promise<void>>();
  private logouts = new Map<string, Promise<void>>();
  /** the shell shows all of this in settings and the pickers, so a change is an `agents` broadcast */
  onChange: (() => void) | null = null;
  private now: () => number;

  constructor(private d: AgentReadinessDeps) {
    this.now = d.now ?? Date.now;
  }

  private entry(agentId: string): Entry {
    let e = this.known.get(agentId);
    if (!e) {
      e = { canLogout: false };
      this.known.set(agentId, e);
    }
    return e;
  }

  /** a live connection reporting what its agent said about itself */
  observe(agentId: string, o: AuthObservation): void {
    const e = this.entry(agentId);
    const before = { ...e };
    if (o.canLogout !== undefined) e.canLogout = o.canLogout;
    if (o.status) {
      e.status = o.status;
      // a login seen by a session is the answer a failed check was waiting for
      if (o.status.kind !== "none") delete e.failure;
    }
    if (before.canLogout !== e.canLogout || !same(before.status, e.status) || before.failure !== e.failure) {
      this.onChange?.();
    }
  }

  /** a reply reporting how much of the account's plan is spent. The latest word wins whichever
   * worktree heard it: the windows are the account's, and every session reads the same ones. */
  observeLimits(agentId: string, limits: AgentLimits): void {
    const e = this.entry(agentId);
    const before = e.limits;
    e.limits = limits;
    // the same figures again (the SDK repeats them when only the reset time's rounding moves)
    // are not news; `at` alone moving is left out of the comparison for that reason
    if (!sameLimits(before, limits)) this.onChange?.();
  }

  /** every agent as the shell sees it: the registry's row plus everything learned by running it */
  describe(): AgentInfo[] {
    return this.d.infos().map((info) => {
      const e = this.known.get(info.id);
      const models = this.d.options(info.id, "model");
      const efforts = this.d.options(info.id, "thought_level");
      return {
        ...info,
        ...(models.length > 0 ? { models } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(this.d.quick(info.id) ? { quick: true as const } : {}),
        ...(e?.status ? { auth: e.status } : {}),
        ...(e?.canLogout ? { canLogout: true } : {}),
        ...(e?.limits ? { limits: e.limits } : {}),
        ...(e?.failure ? { checkFailed: e.failure } : {}),
      };
    });
  }

  /** nothing left to learn by running it: its sessions keep the rest current */
  private positive(agentId: string): boolean {
    const e = this.known.get(agentId);
    return this.d.options(agentId, "model").length > 0 && !e?.failure && e?.status?.kind !== "none";
  }

  /** Look at an agent again, if that is worth a spawn: it is installed, nobody is looking at it
   * right now, its answer is not positive, and the last look is older than the cooldown. Never
   * rejects; what went wrong is the agent's `checkFailed`. */
  check(agentId: string): Promise<void> {
    const info = this.d.infos().find((a) => a.id === agentId);
    if (!info?.available) return Promise.resolve();
    const running = this.inflight.get(agentId);
    if (running) return running;
    if (this.positive(agentId)) return Promise.resolve();
    const e = this.known.get(agentId);
    if (e?.checkedAt !== undefined && this.now() - e.checkedAt < CHECK_COOLDOWN_MS) return Promise.resolve();
    const p = this.run(agentId).finally(() => {
      if (this.inflight.get(agentId) === p) this.inflight.delete(agentId);
    });
    this.inflight.set(agentId, p);
    return p;
  }

  /** boot and install: every agent that can run and has never listed its models, in turn */
  async checkMissing(): Promise<void> {
    for (const a of this.d.infos()) {
      if (a.available && this.d.options(a.id, "model").length === 0) await this.check(a.id);
    }
  }

  private async run(agentId: string): Promise<void> {
    const tag = `check:${agentId}`;
    // what the adapter says about itself, applied together at the end: a push that lands mid-look
    // must not clear a failure the same look is about to set again, and the shell hears one
    // change, not three
    const found: AuthObservation = {};
    let spec: AgentSpec;
    try {
      spec = this.d.require(agentId);
    } catch (e) {
      this.finish(agentId, firstLine(e), found);
      return;
    }
    // nothing is prompted, so nothing should ask; the update handler is for the command list an
    // adapter pushes unasked when a session opens, and the other for the identity it pushes on
    // initialize, which is the answer settings shows
    const app = acp
      .client({ name: "toyon" })
      .onNotification(acp.methods.client.session.update, () => {})
      .onNotification(AUTH_STATUS_UPDATE_METHOD, parseAuthStatus, (c) => {
        if (c.params) found.status = c.params;
      });
    let link: AcpLink;
    try {
      link = await this.d.connect(app, spec);
    } catch (e) {
      log.warn(tag, "could not start the agent", e);
      this.finish(agentId, firstLine(e), found);
      return;
    }
    let failure: string | undefined;
    try {
      const init = await link.conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "toyon", version: "0" },
      });
      found.canLogout = supportsLogout(init.agentCapabilities);
      const s = await link.conn.agent.request(acp.methods.agent.session.new, { cwd: this.d.cwd, mcpServers: [] });
      for (const [category, opt] of readOptions(s.configOptions)) this.d.learned(agentId, category, opt.choices);
      if (init.agentCapabilities?.sessionCapabilities?.close) {
        await link.conn.agent.request(acp.methods.agent.session.close, { sessionId: s.sessionId }).catch((e) => {
          log.debug(tag, `session/close failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } catch (e) {
      // no credential is the usual way this ends, and the agent's own hint names the way in
      failure = isAuthRequired(e) ? spec.loginHint : firstLine(e);
      log.info(tag, `could not read its models: ${failure}`);
    } finally {
      link.conn.close();
      await link.kill();
    }
    this.finish(agentId, failure, found);
  }

  private finish(agentId: string, failure: string | undefined, found: AuthObservation): void {
    const e = this.entry(agentId);
    const before = { ...e };
    if (found.canLogout !== undefined) e.canLogout = found.canLogout;
    if (found.status) e.status = found.status;
    e.failure = failure;
    e.checkedAt = this.now();
    if (before.canLogout !== e.canLogout || !same(before.status, e.status) || before.failure !== e.failure) {
      this.onChange?.();
    }
  }

  /** Sign the agent out of whatever it is logged into. Concurrent calls share one run, and a run
   * waits for a check in flight so the two never spawn beside each other. Live worktree sessions
   * are left alone: each already holds its credential in memory and would only lose a turn in
   * flight, and the next spawn reads the store this just emptied. */
  logout(agentId: string): Promise<void> {
    const running = this.logouts.get(agentId);
    if (running) return running;
    const prior = this.inflight.get(agentId) ?? Promise.resolve();
    const p = prior
      .then(() => this.runLogout(agentId))
      .finally(() => {
        this.logouts.delete(agentId);
        this.inflight.delete(agentId);
      });
    this.logouts.set(agentId, p);
    // a check arriving meanwhile joins this and spawns nothing; it must not see the refusal
    this.inflight.set(
      agentId,
      p.catch(() => undefined),
    );
    return p;
  }

  private async runLogout(agentId: string): Promise<void> {
    const spec = this.d.require(agentId);
    let pushed: AuthStatus | null = null;
    // A connection reports the identity it starts with too, and one adapter sends that one after
    // the initialize response rather than before it. Only what arrives once the sign-out is under
    // way can be the identity it leaves us with.
    let signingOut = false;
    const app = acp.client({ name: "toyon" }).onNotification(AUTH_STATUS_UPDATE_METHOD, parseAuthStatus, (c) => {
      if (c.params && signingOut) pushed = c.params;
    });
    const link = await this.d.connect(app, spec);
    try {
      const init = await link.conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "toyon", version: "0" },
      });
      if (!supportsLogout(init.agentCapabilities)) throw new UserError(`${spec.name} cannot be signed out from here`);
      signingOut = true;
      await link.conn.agent.request(acp.methods.agent.logout, {});
      // The adapters push their new identity while handling logout, so on one stream it has already
      // arrived. Without it we no longer know what the agent would report: forget rather than guess,
      // and the next connection fills the row back in. What a check had found goes with it: the
      // answer is negative now whatever it was, and the next look re-reads it.
      const before = this.known.get(agentId);
      this.known.set(agentId, { canLogout: true, ...(pushed ? { status: pushed } : {}) });
      if (!before || !same(before.status, pushed ?? undefined) || before.failure !== undefined) this.onChange?.();
      log.info("agents", `${agentId} signed out`);
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(`${spec.name} could not be signed out: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await link.kill();
    }
  }
}

/** the one line of an error a row can carry: the SDK's "Internal error: " prefix and the stderr
 * tail an exit report drags along are not for a picker row */
function firstLine(e: unknown): string {
  // the SDK answers a handler that threw with "Internal error" and the thrown words under `details`
  const details = e instanceof acp.RequestError ? (e.data as { details?: unknown } | null)?.details : undefined;
  const message = typeof details === "string" ? details : e instanceof Error ? e.message : String(e);
  return message.replace(/^Internal error: /, "").split("\n")[0] ?? message;
}

function sameLimits(a: AgentLimits | undefined, b: AgentLimits | undefined): boolean {
  if (!a || !b) return a === b;
  const win = (x: AgentLimits["windows"]["five_hour"]) => (x ? `${x.used}@${x.resetsAt}` : "");
  return (
    a.status === b.status &&
    a.binding === b.binding &&
    win(a.windows.five_hour) === win(b.windows.five_hour) &&
    win(a.windows.seven_day) === win(b.windows.seven_day)
  );
}

function same(a: AuthStatus | undefined, b: AuthStatus | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.account?.email === b.account?.email &&
    a.account?.organization === b.account?.organization &&
    a.account?.plan === b.account?.plan
  );
}
