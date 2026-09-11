// Ask an agent one question with no worktree behind it (the batch planner runs before any
// worktree exists): spawn the adapter, ask, kill it.

import * as acp from "@agentclientprotocol/sdk";
import { log } from "../core/log.ts";
import { askOnce } from "./acp/ask.ts";
import { spawnAcp } from "./acp/transport.ts";
import type { AskOpts } from "./adapter.ts";
import { decideUnattended } from "./policy.ts";
import type { AgentRegistry } from "./registry.ts";
import { worktreeBounds } from "./sandbox.ts";

export async function askFreshAgent(
  agents: AgentRegistry,
  agentId: string,
  cwd: string,
  system: string,
  prompt: string,
  opts: AskOpts = {},
): Promise<string | null> {
  const spec = agents.require(agentId);
  const bounds = await worktreeBounds(cwd);
  const listeners = new Map<string, (text: string) => void>();
  const app = acp
    .client({ name: "toyon" })
    // read-only mode should mean none arrive; if one does, the worktree rules still apply.
    // Nothing here can ask a person: this runs before a worktree exists, so there is no chat to
    // draw a card in. For the same reason the client capabilities below stay as they are: without
    // `elicitation.form` the Claude adapter drops AskUserQuestion from the tool list, so the namer
    // and the batch planner cannot ask either.
    .onRequest(acp.methods.client.session.requestPermission, (c) => decideUnattended(c.params, bounds, cwd))
    .onNotification(acp.methods.client.session.update, (c) => {
      const u = c.params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
        listeners.get(c.params.sessionId)?.(u.content.text);
      }
    });
  const link = spawnAcp(app, agents.launch(spec), cwd, `ask:${agentId}`);
  try {
    const init = await link.conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "toyon", version: "0" },
    });
    return await askOnce(link.conn.agent, {
      cwd,
      system,
      prompt,
      spec,
      ...(opts.quick ? { quick: opts.quick } : {}),
      route: (id, onText) => {
        listeners.set(id, onText);
        return () => listeners.delete(id);
      },
      caps: {
        close: !!init.agentCapabilities?.sessionCapabilities?.close,
        delete: !!init.agentCapabilities?.sessionCapabilities?.delete,
      },
      tag: `ask:${agentId}`,
    });
  } catch (e) {
    log.warn(`ask:${agentId}`, "one-shot question failed", e);
    return null;
  } finally {
    link.conn.close();
    await link.kill();
  }
}
