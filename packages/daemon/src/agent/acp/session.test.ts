import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent, AgentStatus } from "@toyon/shared";
import { SYSTEM_APPEND } from "../prompt.ts";
import type { AgentSpec } from "../registry.ts";
import type { Bounds } from "../sandbox.ts";
import { AcpSession } from "./session.ts";
import type { AcpLink } from "./transport.ts";

// The session talks to an in-process acp.agent() through the SDK's transport-less connect, so
// every ACP exchange is real and nothing is spawned. `script` decides what the fake does per prompt.

const home = realpathSync(mkdtempSync(join(tmpdir(), "toyon-acp-session-")));
const wt = join(home, "wt");
const bounds: Bounds = { root: wt, allowWrite: [wt, "/tmp"], denyWrite: [join(wt, ".claude")], gitDir: null };
afterEach(() => {
  /* each test uses its own worktree id, so nothing to reset */
});
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const claudeSpec: AgentSpec = {
  id: "claude",
  name: "Claude",
  builtin: true,
  run: { kind: "command", command: "x" },
  confinement: "claude-settings",
  systemPrompt: "meta-append",
  loginHint: "please log in",
};
const codexSpec: AgentSpec = {
  ...claudeSpec,
  id: "codex",
  name: "Codex",
  confinement: "adapter-sandbox",
  systemPrompt: "prompt-prefix",
  mode: "agent",
};

type PromptScript = (params: acp.PromptRequest, client: acp.AgentContext) => Promise<acp.PromptResponse>;

interface FakeAgent {
  app: acp.AgentApp;
  newSessions: acp.NewSessionRequest[];
  loads: acp.LoadSessionRequest[];
  prompts: acp.PromptRequest[];
  cancels: number;
  modes: string[];
  script: PromptScript;
  loadSession: boolean;
  failLoad: boolean;
}

function fakeAgent(script: PromptScript, opts: { loadSession?: boolean; withModes?: boolean } = {}): FakeAgent {
  const f: FakeAgent = {
    newSessions: [],
    loads: [],
    prompts: [],
    cancels: 0,
    modes: [],
    script,
    loadSession: opts.loadSession ?? true,
    failLoad: false,
    app: null!,
  };
  let n = 0;
  const modes = opts.withModes
    ? {
        currentModeId: "read-only",
        availableModes: [
          { id: "read-only", name: "ro" },
          { id: "agent", name: "agent" },
        ],
      }
    : null;
  f.app = acp
    .agent({ name: "fake" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: f.loadSession },
      authMethods: [
        { id: "api-key", name: "API Key" },
        { id: "chat-gpt", name: "ChatGPT", description: "browser" },
        { id: "claude-login", name: "Claude login", type: "terminal", args: ["--cli", "auth", "login"] },
      ],
    }))
    .onRequest(acp.methods.agent.session.new, (c) => {
      f.newSessions.push(c.params);
      return {
        sessionId: `s${++n}`,
        modes,
        configOptions: [
          { id: "model", name: "m", category: "model", type: "select", currentValue: "test-model", options: [] },
        ],
      };
    })
    .onRequest(acp.methods.agent.session.load, async (c) => {
      f.loads.push(c.params);
      if (f.failLoad) throw new acp.RequestError(-32602, "no such session");
      // the replay: a client must not treat this as new output
      await c.client.notify(acp.methods.client.session.update, {
        sessionId: c.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAY" } },
      });
      return { modes };
    })
    .onRequest(acp.methods.agent.session.setMode, (c) => {
      f.modes.push(c.params.modeId);
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, (c) => {
      f.prompts.push(c.params);
      return f.script(c.params, c.client);
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      f.cancels++;
    });
  return f;
}

const say =
  (text: string): PromptScript =>
  async (p, client) => {
    await client.notify(acp.methods.client.session.update, {
      sessionId: p.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
    return { stopReason: "end_turn" };
  };

function world(fake: FakeAgent, spec = claudeSpec, idleMs = 60_000) {
  const id = `w${Math.random().toString(36).slice(2, 8)}`;
  const events: AgentEvent[] = [];
  const statuses: AgentStatus[] = [];
  let sessionId: string | undefined;
  const links: Array<{ killed: boolean }> = [];
  const connect = (app: acp.ClientApp): AcpLink => {
    const conn = app.connect(fake.app);
    const rec = { killed: false };
    links.push(rec);
    return {
      conn,
      kill: async () => {
        rec.killed = true;
        conn.close();
      },
      exited: new Promise(() => {}),
      exitInfo: () => null,
    };
  };
  const session = new AcpSession({
    worktreeId: id,
    cwd: wt,
    spec: () => spec,
    connect,
    launch: () => ({ command: "/bin/agent", args: ["run.js"] }),
    transcriptsDir: home,
    getSessionId: () => sessionId,
    setSessionId: (s) => {
      sessionId = s;
    },
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    idleMs,
    prepare: async () => bounds,
  });
  const idle = async () => {
    for (let i = 0; i < 200 && (session.status === "working" || session.queueLength > 0); i++) await Bun.sleep(5);
  };
  const types = () => events.map((e) => e.type);
  return { session, events, statuses, types, idle, links, sessionId: () => sessionId, id };
}

describe("AcpSession", () => {
  test("a turn: user-message, turn-start, session-info, deltas, turn-end; transcript on disk; status back to idle", async () => {
    const fake = fakeAgent(say("hello"));
    const w = world(fake);
    w.session.send("hi", "ctx");
    await w.idle();
    expect(w.types()).toEqual(["user-message", "turn-start", "session-info", "text-delta", "turn-end"]);
    expect(w.events[2]).toMatchObject({ sessionId: "s1", model: "test-model" });
    expect(w.events[4]).toMatchObject({ stopReason: "end_turn" });
    expect(w.statuses).toEqual(["working", "idle"]);
    // context reaches the prompt but never the transcript
    expect(fake.prompts[0]!.prompt).toEqual([{ type: "text", text: "hi\n\nctx" }]);
    expect((w.events[0] as { text: string }).text).toBe("hi");
    expect(fake.newSessions[0]!._meta).toEqual({ systemPrompt: { append: SYSTEM_APPEND } });
    expect(w.sessionId()).toBe("s1");
    await w.session.close();
    const lines = readFileSync(join(home, `${w.id}.jsonl`), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(5);
    expect(w.links[0]!.killed).toBe(true);
  });

  test("queued prompts run in order on one process; the queue is visible in between", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = fakeAgent(async (p, client) => {
      if (p.prompt[0]!.type === "text" && p.prompt[0]!.text === "one") await gate;
      return say(`re:${(p.prompt[0] as { text: string }).text}`)(p, client);
    });
    const w = world(fake);
    const queues: string[][] = [];
    w.session.onQueueChange = () => queues.push(w.session.queueItems);
    w.session.send("one");
    await Bun.sleep(20);
    w.session.send("two");
    expect(w.session.queueItems).toEqual(["two"]);
    release();
    await w.idle();
    expect(fake.prompts.map((p) => (p.prompt[0] as { text: string }).text)).toEqual(["one", "two"]);
    expect(fake.newSessions).toHaveLength(1);
    expect(w.types().filter((t) => t === "turn-end")).toHaveLength(2);
    expect(queues.at(-1)).toEqual([]);
    await w.session.close();
  });

  test("stop() cancels the turn, drops the queue, and the turn ends as interrupted", async () => {
    const fake = fakeAgent(
      (p) =>
        new Promise((resolve) => {
          const t = setInterval(() => {
            if (fake.cancels > 0) {
              clearInterval(t);
              resolve({ stopReason: "cancelled" });
            }
          }, 5);
          void p;
        }),
    );
    const w = world(fake);
    w.session.send("go");
    w.session.send("later");
    await Bun.sleep(30);
    expect(w.session.status).toBe("working");
    w.session.stop();
    await w.idle();
    expect(fake.cancels).toBe(1);
    expect(w.session.queueItems).toEqual([]);
    expect(w.events.at(-1)).toMatchObject({ type: "turn-end", stopReason: "interrupted" });
    expect(fake.prompts).toHaveLength(1);
    await w.session.close();
  });

  test("permission requests are answered by policy: inside allowed, outside rejected with agent-blocked", async () => {
    const answers: string[] = [];
    const fake = fakeAgent(async (p, client) => {
      for (const path of [join(wt, "ok.ts"), "/etc/passwd"]) {
        const r = await client.request(acp.methods.client.session.requestPermission, {
          sessionId: p.sessionId,
          toolCall: { toolCallId: "t", title: "Edit", kind: "edit", locations: [{ path }] },
          options: [
            { optionId: "allow-once", name: "a", kind: "allow_once" },
            { optionId: "reject", name: "r", kind: "reject_once" },
          ],
        });
        answers.push(r.outcome.outcome === "selected" ? r.outcome.optionId : "cancelled");
      }
      return { stopReason: "end_turn" };
    });
    const w = world(fake);
    w.session.send("edit");
    await w.idle();
    expect(answers).toEqual(["allow-once", "reject"]);
    const blocked = w.events.find((e) => e.type === "agent-blocked");
    expect(blocked).toMatchObject({ tool: "Edit", path: "/etc/passwd" });
    await w.session.close();
  });

  test("prompt-prefix agents get SYSTEM_APPEND on the first prompt of a new session only, and their mode set", async () => {
    const fake = fakeAgent(say("ok"), { withModes: true });
    const w = world(fake, codexSpec);
    w.session.send("a");
    w.session.send("b");
    await w.idle();
    expect(fake.newSessions[0]!._meta).toBeUndefined();
    expect((fake.prompts[0]!.prompt[0] as { text: string }).text).toBe(`${SYSTEM_APPEND}\n\na`);
    expect((fake.prompts[1]!.prompt[0] as { text: string }).text).toBe("b");
    expect(fake.modes).toEqual(["agent"]);
    await w.session.close();
  });

  test("the reaper kills an idle process; the next prompt respawns, resumes via session/load, and drops the replay", async () => {
    const fake = fakeAgent(say("again"));
    const w = world(fake, claudeSpec, 10);
    w.session.send("first");
    await w.idle();
    for (let i = 0; i < 100 && !w.links[0]!.killed; i++) await Bun.sleep(5);
    expect(w.links[0]!.killed).toBe(true);
    w.session.send("second");
    await w.idle();
    expect(w.links).toHaveLength(2);
    expect(fake.loads).toHaveLength(1);
    expect(fake.loads[0]!.sessionId).toBe("s1");
    expect(fake.newSessions).toHaveLength(1);
    expect(w.events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text)).toEqual([
      "again",
      "again",
    ]);
    expect(w.sessionId()).toBe("s1");
    await w.session.close();
  });

  test("a failed session/load falls back to session/new and the stored id moves on", async () => {
    const fake = fakeAgent(say("x"));
    const w = world(fake, claudeSpec, 10);
    w.session.send("first");
    await w.idle();
    for (let i = 0; i < 100 && !w.links[0]!.killed; i++) await Bun.sleep(5);
    fake.failLoad = true;
    w.session.send("second");
    await w.idle();
    expect(fake.loads).toHaveLength(1);
    expect(fake.newSessions).toHaveLength(2);
    expect(w.sessionId()).toBe("s2");
    expect(w.session.status).toBe("idle");
    await w.session.close();
  });

  test("an agent without loadSession always starts a new session after a reap", async () => {
    const fake = fakeAgent(say("x"), { loadSession: false });
    const w = world(fake, claudeSpec, 10);
    w.session.send("first");
    await w.idle();
    for (let i = 0; i < 100 && !w.links[0]!.killed; i++) await Bun.sleep(5);
    w.session.send("second");
    await w.idle();
    expect(fake.loads).toHaveLength(0);
    expect(fake.newSessions).toHaveLength(2);
    await w.session.close();
  });

  test("authRequired becomes an auth card; a login over the same connection sends the message again", async () => {
    let failures = 1;
    const auths: acp.AuthenticateRequest[] = [];
    const fake = fakeAgent(async (p, client) => {
      if (failures-- > 0) throw acp.RequestError.authRequired();
      return say("ok")(p, client);
    });
    fake.app.onRequest(acp.methods.agent.authenticate, (c) => {
      auths.push(c.params);
      return {};
    });
    const w = world(fake);
    w.session.send("a");
    await w.idle();
    expect(w.session.status).toBe("error");
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-auth-required" }>;
    expect(card.type).toBe("agent-auth-required");
    expect(card.agentName).toBe("Claude");
    expect(card.methods).toEqual([
      { id: "api-key", name: "API Key", kind: "agent", needsKey: true },
      { id: "chat-gpt", name: "ChatGPT", description: "browser", kind: "agent" },
      { id: "claude-login", name: "Claude login", kind: "terminal" },
    ]);
    expect(w.links).toHaveLength(1);
    expect(w.links[0]!.killed).toBe(false);
    // a terminal method hands back the adapter's own command line with the method's args
    expect(await w.session.authenticate("claude-login")).toEqual({
      kind: "terminal",
      line: "/bin/agent run.js --cli auth login",
    });
    // an agent method runs over the live connection, then the refused message goes again
    expect(await w.session.authenticate("api-key", "sk-test")).toEqual({ kind: "done" });
    expect(auths).toEqual([{ methodId: "api-key", _meta: { "api-key": { apiKey: "sk-test" } } }]);
    await w.idle();
    expect(w.session.status).toBe("idle");
    expect(w.types().filter((t) => t === "user-message")).toHaveLength(2);
    expect(w.types()).toContain("agent-auth-ok");
    expect(w.events.at(-1)).toMatchObject({ type: "turn-end", stopReason: "end_turn" });
    expect(w.links).toHaveLength(1);
    await expect(w.session.authenticate("nope")).rejects.toThrow(/no login method/);
    await w.session.close();
  });

  test("a non-auth failure still drops the process and reports the message", async () => {
    let failures = 1;
    const fake = fakeAgent(async (p, client) => {
      if (failures-- > 0) throw new acp.RequestError(-32603, "model overloaded");
      return say("ok")(p, client);
    });
    const w = world(fake);
    w.session.send("a");
    await w.idle();
    expect(w.session.status).toBe("error");
    expect(w.events.at(-1)).toMatchObject({ type: "agent-error", message: "model overloaded" });
    expect(w.links[0]!.killed).toBe(true);
    w.session.send("b");
    await w.idle();
    expect(w.session.status).toBe("idle");
    expect(w.links).toHaveLength(2);
    expect(w.events.at(-1)).toMatchObject({ type: "turn-end", stopReason: "end_turn" });
    await w.session.close();
  });

  test("the connection dying mid-turn is an agent-error, not a hang", async () => {
    let conn: acp.ClientConnection | null = null;
    const fake = fakeAgent(
      () =>
        new Promise(() => {
          setTimeout(() => conn?.close(new Error("ACP connection closed")), 10);
        }),
    );
    const w = world(fake);
    const orig = w.session as unknown as { d: { connect: (app: acp.ClientApp, spec: AgentSpec) => AcpLink } };
    const inner = orig.d.connect;
    orig.d.connect = (app, spec) => {
      const link = inner(app, spec);
      conn = link.conn;
      link.exitInfo = () => "agent process exited (signal SIGKILL): oom";
      return link;
    };
    w.session.send("a");
    await w.idle();
    expect(w.session.status).toBe("error");
    expect(w.events.at(-1)).toMatchObject({
      type: "agent-error",
      message: "agent process exited (signal SIGKILL): oom",
    });
  });

  test("close() never stores a session id afterwards and drops later sends", async () => {
    const fake = fakeAgent(say("x"));
    const w = world(fake);
    await w.session.close();
    w.session.send("a");
    await Bun.sleep(30);
    expect(fake.newSessions).toHaveLength(0);
    expect(w.sessionId()).toBeUndefined();
  });
});
