// A one-question session on an ACP connection: a system prompt of its own, no chat behind it, the
// reply text and nothing else. Naming a worktree and the landing questions ride on this, on the
// worktree's already-running adapter.

import * as acp from "@agentclientprotocol/sdk/unstable";
import { fireAndForget, log } from "../../core/log.ts";
import type { Quick } from "../adapter.ts";
import { agentModeFor } from "../modes.ts";
import { quickModelFor } from "../quick.ts";
import type { AgentSpec } from "../registry.ts";
import { errorWords } from "./errors.ts";
import { readModeOption, readOptions } from "./options.ts";

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
  /** absent asks on whatever model the agent opens a session on */
  quick?: Quick;
  /** the answer is null once this has passed, and the side session is told to stop; absent waits
   * as long as the adapter takes */
  timeoutMs?: number;
  tag: string;
}

/** the deadline's answer, told apart from an agent that answered with nothing */
const LATE = Symbol("late");

/** what the run hands over once its side session is open; whether to go on with the question */
type Opened = (sessionId: string, unroute: () => void) => boolean;

export async function askOnce(ctx: acp.ClientContext, a: Ask): Promise<string | null> {
  if (a.timeoutMs === undefined) return askRun(ctx, a, () => true);
  // The run is not stopped at the deadline: its own finally closes the side session, whenever it
  // gets there. The caller is let go, the session's updates stop being read, and the adapter is
  // asked to stop the session. A session that only opens after the deadline is closed unasked.
  let late = false;
  let open: { sessionId: string; unroute: () => void } | undefined;
  const cancel = (sessionId: string) =>
    fireAndForget(a.tag, ctx.notify(acp.methods.agent.session.cancel, { sessionId }), "ask: cancel side session");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof LATE>((r) => {
    timer = setTimeout(() => r(LATE), a.timeoutMs);
    // a deadline on a question nobody is waiting for must not keep a shutdown (or a test) alive
    timer.unref?.();
  });
  const run = askRun(ctx, a, (sessionId, unroute) => {
    if (!late) open = { sessionId, unroute };
    return !late;
  });
  try {
    const out = await Promise.race([run, deadline]);
    if (out !== LATE) return out;
  } finally {
    clearTimeout(timer);
  }
  late = true;
  log.warn(a.tag, `ask: no answer in ${Math.round(a.timeoutMs / 1000)} s; given up`);
  // the run's own failures are logged inside it; the one before its try, session/new, is not,
  // and a run nobody awaits any more must not reject into the void
  run.catch((e) => log.warn(a.tag, "ask failed after the deadline", e));
  if (open) {
    open.unroute();
    cancel(open.sessionId);
  }
  return null;
}

/** the question, start to finish: `opened` gets the side session as soon as there is one, and
 * says whether the question is still wanted */
async function askRun(ctx: acp.ClientContext, a: Ask, opened: Opened): Promise<string | null> {
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
    if (!opened(s.sessionId, unroute)) return null;
    if (a.quick) {
      const model = readOptions(s.configOptions).get("model");
      const quick = model && quickModelFor(a.spec, model.ids, model.current);
      let onQuick = !!quick && model?.current === quick;
      if (model && quick && !onQuick) {
        // before the mode: Claude reconciles its permission mode against the model it is moved to
        try {
          await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId: s.sessionId,
            configId: model.id,
            value: quick,
          });
          onQuick = true;
        } catch (e) {
          // Offered and then refused: a provider lists a model the account may not call (a Bedrock
          // role without that inference profile). The session stays on the model it opened on,
          // which makes this the same as a quick model that was never offered.
          log.warn(a.tag, `ask: ${a.spec.id} would not move to its quick model ${quick}`, e);
        }
      } else if (model && !quick) noteNotOffered(a, model.ids);
      if (!onQuick && a.quick === "require") {
        log.debug(a.tag, `ask: ${a.spec.id} has no quick model to run on; not asked`);
        return null;
      }
    }
    if (s.modes) {
      const readOnly = agentModeFor(
        a.spec,
        "plan",
        s.modes.availableModes.map((m) => m.id),
      );
      if (readOnly && s.modes.currentModeId !== readOnly) {
        await ctx.request(acp.methods.agent.session.setMode, { sessionId: s.sessionId, modeId: readOnly });
      }
    } else {
      // an agent that offers its modes as a config option is put in its read-only one the same way
      const modes = readModeOption(s.configOptions);
      const readOnly = modes && agentModeFor(a.spec, "plan", modes.ids);
      if (modes && readOnly && modes.current !== readOnly) {
        await ctx.request(acp.methods.agent.session.setConfigOption, {
          sessionId: s.sessionId,
          configId: modes.id,
          value: readOnly,
        });
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

/** the agents whose named quick model was missing from their list, as `agent model`: said once
 * per daemon, since every side question would say it again */
const notOffered = new Set<string>();

/** A quick model named for the agent (agents.json, or a builtin's fixed id) that its list does not
 * carry: the name belongs to another provider or a retired model, and nothing else says the
 * setting has stopped doing anything. */
function noteNotOffered(a: Ask, offered: readonly string[]) {
  const named = a.spec.quickModel;
  if (typeof named !== "string") return;
  const key = `${a.spec.id} ${named}`;
  if (notOffered.has(key)) return;
  notOffered.add(key);
  log.warn(a.tag, `ask: ${a.spec.id} does not offer its quick model ${named}; it offers ${offered.join(", ")}`);
}

/** close first, so the adapter stops whatever the session is still doing (Claude's title
 * generation runs after the turn), then delete what it kept */
async function cleanUp(ctx: acp.ClientContext, a: Ask, sessionId: string): Promise<void> {
  const quietly = (what: string) => (e: unknown) => {
    log.debug(a.tag, `ask: session/${what} failed: ${errorWords(e)}`);
  };
  if (a.caps.close) await ctx.request(acp.methods.agent.session.close, { sessionId }).catch(quietly("close"));
  if (a.caps.delete) await ctx.request(acp.methods.agent.session.delete, { sessionId }).catch(quietly("delete"));
}
