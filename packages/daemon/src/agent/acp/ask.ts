// A one-question session on an ACP connection: a system prompt of its own, no chat behind it, the
// reply text and nothing else. Naming a worktree and planning a batch ride on this, on the
// worktree's already-running adapter or on a throwaway one.

import * as acp from "@agentclientprotocol/sdk";
import { fireAndForget, log } from "../../core/log.ts";
import { agentModeFor } from "../modes.ts";
import type { AgentSpec } from "../registry.ts";

export interface Ask {
  cwd: string;
  /** replaces the agent's default system prompt where the adapter allows it; prefixed otherwise */
  system: string;
  prompt: string;
  spec: AgentSpec;
  /** the caller owns update routing: register a listener for this session id, get back the unregister */
  route: (sessionId: string, onText: (text: string) => void) => () => void;
  /** what initialize advertised. Nothing of a side session should outlive its answer: an adapter
   * that keeps its conversations would otherwise list every question in its own resume picker. */
  caps: { close: boolean; delete: boolean };
  tag: string;
}

export async function askOnce(ctx: acp.ClientContext, a: Ask): Promise<string | null> {
  const meta = a.spec.systemPrompt === "meta-append";
  const _meta = { ...a.spec.sideMeta, ...(meta ? { systemPrompt: a.system } : {}) };
  const s = await ctx.request(acp.methods.agent.session.new, {
    cwd: a.cwd,
    mcpServers: [],
    ...(Object.keys(_meta).length > 0 ? { _meta } : {}),
  });
  let text = "";
  const unroute = a.route(s.sessionId, (t) => {
    text += t;
  });
  try {
    if (s.modes) {
      const readOnly = agentModeFor(
        a.spec,
        "plan",
        s.modes.availableModes.map((m) => m.id),
      );
      if (readOnly && s.modes.currentModeId !== readOnly) {
        await ctx.request(acp.methods.agent.session.setMode, { sessionId: s.sessionId, modeId: readOnly });
      }
    }
    const body = meta ? a.prompt : `${a.system}\n\n${a.prompt}`;
    const r = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: body }],
    });
    if (r.stopReason !== "end_turn") log.debug(a.tag, `ask: stopped with ${r.stopReason}`);
    return text.trim() || null;
  } catch (e) {
    log.warn(a.tag, "ask failed", e);
    return null;
  } finally {
    unroute();
    fireAndForget(a.tag, cleanUp(ctx, a, s.sessionId), "ask: clean up side session");
  }
}

/** close first, so the adapter stops whatever the session is still doing (Claude's title
 * generation runs after the turn), then delete what it kept */
async function cleanUp(ctx: acp.ClientContext, a: Ask, sessionId: string): Promise<void> {
  const quietly = (what: string) => (e: unknown) => {
    log.debug(a.tag, `ask: session/${what} failed: ${e instanceof Error ? e.message : String(e)}`);
  };
  if (a.caps.close) await ctx.request(acp.methods.agent.session.close, { sessionId }).catch(quietly("close"));
  if (a.caps.delete) await ctx.request(acp.methods.agent.session.delete, { sessionId }).catch(quietly("delete"));
}
