import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentInfo, ModelChoice } from "@toyon/shared";
import { fakeAgents } from "../../test/helpers/fakes.ts";
import { OptionProbe, type OptionProbeDeps } from "./probe.ts";

// The adapter runs in-process through the SDK's transport-less connect, as in accounts.test.ts:
// every ACP exchange is real and nothing is spawned.
function fakeAdapter(opts: { failNew?: boolean } = {}) {
  const seen = { sessions: 0, closes: 0, prompts: 0, kills: 0 };
  const app = acp
    .agent({ name: "fake" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { sessionCapabilities: { close: {} } },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.new, async () => {
      seen.sessions++;
      if (opts.failNew) throw new Error("Authentication required");
      return {
        sessionId: "s1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select" as const,
            currentValue: "gpt-a",
            options: [
              { value: "gpt-a", name: "gpt-a" },
              { value: "gpt-b", name: "gpt-b", description: "faster" },
            ],
          },
        ],
      };
    })
    .onRequest(acp.methods.agent.session.close, async () => {
      seen.closes++;
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async () => {
      seen.prompts++;
      return { stopReason: "end_turn" as const };
    });
  const connect: OptionProbeDeps["connect"] = async (clientApp) => {
    const conn = clientApp.connect(app);
    return {
      conn,
      kill: async () => {
        seen.kills++;
        conn.close();
      },
      exited: new Promise(() => {}),
      exitInfo: () => null,
    };
  };
  return { seen, connect };
}

function world(adapter: ReturnType<typeof fakeAdapter>, infos: AgentInfo[], known: string[] = []) {
  const agents = fakeAgents("/nowhere");
  const learned: Array<[string, string, ModelChoice[]]> = [];
  const probe = new OptionProbe({
    infos: () => infos,
    require: (id) => agents.require(id),
    connect: adapter.connect,
    cwd: "/nowhere",
    known: (id) => known.includes(id),
    learned: (id, category, choices) => {
      learned.push([id, category, choices]);
    },
  });
  return { probe, learned };
}

const ready = (id: string): AgentInfo => ({ id, name: id, available: true, sandboxed: true });

describe("OptionProbe", () => {
  test("reads an unknown agent's options off a session it opens and closes, and prompts nothing", async () => {
    const adapter = fakeAdapter();
    const w = world(adapter, [ready("claude"), ready("codex")], ["claude"]);
    await w.probe.missing();
    expect(w.learned).toEqual([
      [
        "codex",
        "model",
        [
          { id: "gpt-a", name: "gpt-a" },
          { id: "gpt-b", name: "gpt-b", description: "faster" },
        ],
      ],
    ]);
    expect(adapter.seen).toEqual({ sessions: 1, closes: 1, prompts: 0, kills: 1 });
  });

  test("an agent that is not installed yet is probed once it is, and only once however often asked", async () => {
    const adapter = fakeAdapter();
    const codex: AgentInfo = { ...ready("codex"), available: false, reason: "installing" };
    const w = world(adapter, [codex]);
    await w.probe.missing();
    expect(adapter.seen.sessions).toBe(0);
    codex.available = true;
    await Promise.all([w.probe.missing(), w.probe.missing()]);
    await w.probe.missing();
    expect(adapter.seen.sessions).toBe(1);
  });

  test("a session that fails (not logged in) learns nothing, kills the adapter and is not retried", async () => {
    const adapter = fakeAdapter({ failNew: true });
    const w = world(adapter, [ready("codex")]);
    await w.probe.missing();
    await w.probe.missing();
    expect(w.learned).toEqual([]);
    expect(adapter.seen).toMatchObject({ sessions: 1, kills: 1 });
  });
});
