// What an agent offers (its models, its effort levels) before any worktree has run it. A new
// worktree's picker lists every agent's models, and an agent only lists them when a session opens,
// so one nobody has used yet would offer nothing to pick. A probe opens one session, reads the
// options off session/new and closes it. Nothing is prompted, so nothing is spent.

import * as acp from "@agentclientprotocol/sdk";
import type { AgentInfo, ModelChoice } from "@toyon/shared";
import { log } from "../core/log.ts";
import { readOptions } from "./acp/options.ts";
import type { AcpLink } from "./acp/transport.ts";
import type { AgentSpec } from "./registry.ts";

export interface OptionProbeDeps {
  infos: () => AgentInfo[];
  require: (id: string) => AgentSpec;
  /** spawn the adapter for a short-lived connection */
  connect: (app: acp.ClientApp, spec: AgentSpec) => AcpLink;
  /** where the throwaway session says it works; nothing is prompted, so nothing is written there */
  cwd: string;
  /** a session has listed this agent's models before */
  known: (agentId: string) => boolean;
  learned: (agentId: string, category: string, choices: ModelChoice[]) => void;
}

export class OptionProbe {
  /** tried this run, whatever came of it. The usual failure is an agent that is not logged in,
   * which fails the same way until someone logs in, and that happens in a worktree's chat, whose
   * own session learns the list. */
  private tried = new Set<string>();

  constructor(private d: OptionProbeDeps) {}

  /** every agent that is ready to run and has never listed its models, one at a time */
  async missing(): Promise<void> {
    for (const a of this.d.infos()) {
      if (!a.available || this.tried.has(a.id) || this.d.known(a.id)) continue;
      this.tried.add(a.id);
      await this.probe(a.id);
    }
  }

  private async probe(agentId: string): Promise<void> {
    const tag = `probe:${agentId}`;
    // nothing is prompted, so nothing should ask; the update handler is for the command list an
    // adapter pushes unasked when a session opens
    const app = acp.client({ name: "toyon" }).onNotification(acp.methods.client.session.update, () => {});
    let link: AcpLink;
    try {
      link = this.d.connect(app, this.d.require(agentId));
    } catch (e) {
      log.warn(tag, "could not start the agent to read its models", e);
      return;
    }
    try {
      const init = await link.conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "toyon", version: "0" },
      });
      const s = await link.conn.agent.request(acp.methods.agent.session.new, { cwd: this.d.cwd, mcpServers: [] });
      for (const [category, opt] of readOptions(s.configOptions)) this.d.learned(agentId, category, opt.choices);
      if (init.agentCapabilities?.sessionCapabilities?.close) {
        await link.conn.agent.request(acp.methods.agent.session.close, { sessionId: s.sessionId }).catch((e) => {
          log.debug(tag, `session/close failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } catch (e) {
      log.info(
        tag,
        `could not read its models before a worktree runs it: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      link.conn.close();
      await link.kill();
    }
  }
}
