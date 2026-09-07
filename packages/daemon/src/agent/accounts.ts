// Which credential each agent is running on, and the one write: signing it out.
//
// Login state is per agent, not per worktree — one Codex credential serves every worktree — but it
// is only observable over a live ACP connection. So this holds what the worktree sessions already
// learn for free (they connect anyway, and the adapters push their identity on initialize) and
// spawns a session-less connection of its own only when someone asks to log out. Settings reads the
// cache; a login stays in the chat, where the auth card can also run a method that needs a terminal.

import * as acp from "@agentclientprotocol/sdk";
import type { AgentInfo, AuthStatus } from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { AUTH_STATUS_UPDATE_METHOD, parseAuthStatus, supportsLogout } from "./acp/authstatus.ts";
import type { AcpLink } from "./acp/transport.ts";
import type { AgentSpec } from "./registry.ts";

/** what a connection learned about its agent's credentials */
export interface AuthObservation {
  canLogout?: boolean;
  /** null means "the agent told us nothing", which is not the same as logged out */
  status?: AuthStatus | null;
}

export interface AgentAccountsDeps {
  /** the spec for an id, or a UserError; the registry's own `require` */
  require: (id: string) => AgentSpec;
  /** spawn the adapter for a short-lived connection with no session on it */
  connect: (app: acp.ClientApp, spec: AgentSpec) => AcpLink;
}

export class AgentAccounts {
  private known = new Map<string, { status?: AuthStatus; canLogout: boolean }>();
  private busy = new Map<string, Promise<void>>();
  /** the shell shows login state in settings, so a change is an `agents` broadcast */
  onChange: (() => void) | null = null;

  constructor(private d: AgentAccountsDeps) {}

  /** a live connection reporting what its agent said about itself */
  observe(agentId: string, o: AuthObservation): void {
    // an unknown agent renders exactly like one with nothing to report, so the comparison is
    // against that and not against "had an entry": a push we cannot read is not news
    const before = this.known.get(agentId) ?? { canLogout: false, status: undefined };
    const entry = { ...before };
    if (o.canLogout !== undefined) entry.canLogout = o.canLogout;
    if (o.status) entry.status = o.status;
    this.known.set(agentId, entry);
    if (before.canLogout !== entry.canLogout || !same(before.status, entry.status)) this.onChange?.();
  }

  /** what settings shows per row, folded into the registry's own view of each agent */
  describe(infos: AgentInfo[]): AgentInfo[] {
    return infos.map((info) => {
      const k = this.known.get(info.id);
      if (!k) return info;
      return { ...info, ...(k.status ? { auth: k.status } : {}), ...(k.canLogout ? { canLogout: true } : {}) };
    });
  }

  /** Sign the agent out of whatever it is logged into. Concurrent calls share one run.
   * Live worktree sessions are left alone: each already holds its credential in memory and would
   * only lose a turn in flight, and the next spawn reads the store this just emptied. */
  logout(agentId: string): Promise<void> {
    const running = this.busy.get(agentId);
    if (running) return running;
    const p = this.runLogout(agentId).finally(() => this.busy.delete(agentId));
    this.busy.set(agentId, p);
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
    const link = this.d.connect(app, spec);
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
      // and the next connection fills the row back in.
      const entry = this.known.get(agentId);
      this.known.set(agentId, { canLogout: true, ...(pushed ? { status: pushed } : {}) });
      if (!entry || !same(entry.status, pushed ?? undefined)) this.onChange?.();
      log.info("agents", `${agentId} signed out`);
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(`${spec.name} could not be signed out: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await link.kill();
    }
  }
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
