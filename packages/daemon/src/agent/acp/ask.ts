// A one-question session on an ACP connection: no tools, a system prompt of its own, the reply
// text and nothing else. Naming a worktree and planning a batch ride on this, on the worktree's
// already-running adapter or on a throwaway one.

import * as acp from "@agentclientprotocol/sdk";
import { log } from "../../core/log.ts";
import type { AgentSpec } from "../registry.ts";

export interface Ask {
  cwd: string;
  /** replaces the agent's default system prompt where the adapter allows it; prefixed otherwise */
  system: string;
  prompt: string;
  spec: AgentSpec;
  /** what session/new advertised: pick a read-only mode when one exists */
  modes?: acp.SessionModeState | null;
  /** the caller owns update routing: register a listener for this session id, get back the unregister */
  route: (sessionId: string, onText: (text: string) => void) => () => void;
  closeSupported?: boolean;
  tag: string;
}

/** modes that mean "read, do not act", by the names the builtin adapters use */
const READ_ONLY_MODES = ["read-only", "plan"];

export async function askOnce(ctx: acp.ClientContext, a: Ask): Promise<string | null> {
  const meta = a.spec.systemPrompt === "meta-append";
  const s = await ctx.request(acp.methods.agent.session.new, {
    cwd: a.cwd,
    mcpServers: [],
    ...(meta ? { _meta: { systemPrompt: a.system } } : {}),
  });
  let text = "";
  const unroute = a.route(s.sessionId, (t) => {
    text += t;
  });
  try {
    const ro = s.modes?.availableModes.find((m) => READ_ONLY_MODES.includes(m.id));
    if (ro && s.modes?.currentModeId !== ro.id) {
      await ctx.request(acp.methods.agent.session.setMode, { sessionId: s.sessionId, modeId: ro.id });
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
    if (a.closeSupported) {
      ctx.request(acp.methods.agent.session.close, { sessionId: s.sessionId }).catch((e) => {
        log.debug(a.tag, `ask: session/close failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }
}
