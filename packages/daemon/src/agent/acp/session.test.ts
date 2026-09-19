import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentCommand, AgentEvent, AgentStatus, AuthStatus } from "@toyon/shared";
import type { AuthObservation } from "../accounts.ts";
import { AttachmentStore } from "../attachments.ts";
import { PLAN_REL, planEdited, writePlanDoc } from "../planDoc.ts";
import { SYSTEM_APPEND } from "../prompt.ts";
import type { AgentSpec } from "../registry.ts";
import type { Bounds } from "../sandbox.ts";
import { AUTH_STATUS_UPDATE_METHOD } from "./authstatus.ts";
import { AcpSession, type AcpSessionDeps } from "./session.ts";
import { STEER_METHOD } from "./steering.ts";
import type { AcpLink } from "./transport.ts";

// The session talks to an in-process acp.agent() through the SDK's transport-less connect, so
// every ACP exchange is real and nothing is spawned. `script` decides what the fake does per prompt.

const home = realpathSync(mkdtempSync(join(tmpdir(), "toyon-acp-session-")));
const wt = join(home, "wt");
const bounds: Bounds = {
  root: wt,
  allowWrite: [wt, "/tmp"],
  denyWrite: [join(wt, ".claude")],
  denyRead: [],
  gitDir: null,
};
afterAll(() => rmSync(home, { recursive: true, force: true }));

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
  inits: acp.InitializeRequest[];
  newSessions: acp.NewSessionRequest[];
  /** session/load, which replays history: registered so a client that asks for one is caught */
  loads: acp.LoadSessionRequest[];
  resumes: acp.ResumeSessionRequest[];
  prompts: acp.PromptRequest[];
  steers: Array<{ sessionId: string; prompt: acp.ContentBlock[]; _meta?: unknown }>;
  cancels: number;
  /** what the next `_session/steering` answers; the agent decides, so the client must take any */
  steerOutcome: "injected" | "promptRequired" | "startedNewTurn";
  steerError: boolean;
  modes: string[];
  /** set_config_option calls as `<id>=<value>` */
  configs: string[];
  /** the model and effort the fake is on, and its option list as it stands, for an update sent
   * from inside a prompt script */
  model: string;
  effort: string;
  options: () => acp.SessionConfigOption[];
  script: PromptScript;
  resumeSession: boolean;
  failResume: boolean;
  /** what a side question asks for besides new and prompt, in the order it arrived:
   * `config <id>=<value>`, `mode <id>`, `close <sessionId>`, `delete <sessionId>` */
  calls: string[];
}

function fakeAgent(
  script: PromptScript,
  opts: {
    resumeSession?: boolean;
    withModes?: boolean;
    currentMode?: string;
    images?: boolean;
    logout?: boolean;
    steering?: boolean;
    authStatus?: AuthStatus;
    /** commands to push from inside session/new, keyed by the id it is about to return: that is
     * when real adapters send them, before the client knows the session exists */
    commands?: Record<string, Array<{ name: string; description?: string; input?: { hint: string } }>>;
    /** advertise an effort option (under `id`, `effort` by default) while the current model is
     * one of `for`: Claude's shape, where effort comes and goes with the model */
    effort?: { id?: string; for: string[] };
    /** advertise session/close and session/delete */
    caps?: { close?: boolean; delete?: boolean };
    /** offer build and plan as a `mode` config option, starting on this one: OpenCode's shape */
    modeOption?: string;
    /** offer a login through a terminal-auth `_meta`, as OpenCode does */
    authMeta?: boolean;
  } = {},
): FakeAgent {
  const f: FakeAgent = {
    inits: [],
    newSessions: [],
    model: "test-model",
    effort: "default",
    options: () => configOptions(),
    loads: [],
    resumes: [],
    prompts: [],
    steers: [],
    cancels: 0,
    steerOutcome: "injected",
    steerError: false,
    modes: [],
    configs: [],
    script,
    resumeSession: opts.resumeSession ?? true,
    failResume: false,
    calls: [],
    app: null!,
  };
  let n = 0;
  let agentMode = opts.modeOption;
  const configOptions = (): acp.SessionConfigOption[] => [
    ...(agentMode
      ? [
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select" as const,
            currentValue: agentMode,
            options: [
              { value: "build", name: "build" },
              { value: "plan", name: "plan" },
            ],
          },
        ]
      : []),
    {
      id: "model",
      name: "m",
      category: "model",
      type: "select",
      currentValue: f.model,
      options: [
        { value: "test-model", name: "Test Model" },
        { value: "big-model", name: "Big Model", description: "slower" },
      ],
    },
    ...(opts.effort?.for.includes(f.model)
      ? [
          {
            id: opts.effort.id ?? "effort",
            name: "Effort",
            category: "thought_level",
            type: "select" as const,
            currentValue: f.effort,
            options: [
              { value: "default", name: "Default" },
              { value: "high", name: "High" },
            ],
          },
        ]
      : []),
  ];
  const modes = opts.withModes
    ? {
        currentModeId: opts.currentMode ?? "read-only",
        availableModes: [
          { id: "read-only", name: "ro" },
          { id: "agent", name: "agent" },
        ],
      }
    : null;
  f.app = acp
    .agent({ name: "fake" })
    .onRequest(acp.methods.agent.initialize, async (c) => {
      f.inits.push(c.params);
      // the identity push goes out before the response, as both real adapters send it
      if (opts.authStatus) await c.client.notify(AUTH_STATUS_UPDATE_METHOD, { authStatus: opts.authStatus });
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          // every real adapter advertises load; the point is that toyon must not take it
          loadSession: true,
          promptCapabilities: { image: opts.images ?? false },
          ...(opts.logout ? { auth: { logout: {} } } : {}),
          sessionCapabilities: {
            ...(f.resumeSession ? { resume: {} } : {}),
            ...(opts.caps?.close ? { close: {} } : {}),
            ...(opts.caps?.delete ? { delete: {} } : {}),
          },
        },
        authMethods: [
          { id: "api-key", name: "API Key" },
          { id: "chat-gpt", name: "ChatGPT", description: "browser" },
          { id: "claude-login", name: "Claude login", type: "terminal", args: ["--cli", "auth", "login"] },
          ...(opts.authMeta
            ? [
                {
                  id: "opencode-login",
                  name: "Login with opencode",
                  _meta: { "terminal-auth": { command: "opencode", args: ["auth", "login"], label: "OpenCode Login" } },
                },
              ]
            : []),
        ],
        ...(opts.steering ? { _meta: { steering: { supported: true } } } : {}),
      };
    })
    .onRequest(
      STEER_METHOD,
      (v) => v as { sessionId: string; prompt: acp.ContentBlock[]; _meta?: unknown },
      (c) => {
        f.steers.push(c.params);
        if (f.steerError) throw new acp.RequestError(-32602, "the model does not accept that");
        return { outcome: f.steerOutcome };
      },
    )
    .onRequest(acp.methods.agent.session.new, async (c) => {
      f.newSessions.push(c.params);
      const id = `s${++n}`;
      const pushed = opts.commands?.[id];
      if (pushed) {
        await c.client.notify(acp.methods.client.session.update, {
          sessionId: id,
          update: { sessionUpdate: "available_commands_update", availableCommands: pushed },
        });
      }
      return { sessionId: id, modes, configOptions: configOptions() };
    })
    .onRequest(acp.methods.agent.session.load, async (c) => {
      f.loads.push(c.params);
      // the replay: whatever a client did with these, the last of them has been seen to land after
      // the response resolves, so the only safe number of them to receive is none
      for (const text of ["RE", "PLAY"]) {
        await c.client.notify(acp.methods.client.session.update, {
          sessionId: c.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
      }
      return { modes };
    })
    .onRequest(acp.methods.agent.session.resume, (c) => {
      f.resumes.push(c.params);
      if (f.failResume) throw new acp.RequestError(-32602, "no such session");
      return { modes, configOptions: configOptions() };
    })
    .onRequest(acp.methods.agent.session.setMode, (c) => {
      f.modes.push(c.params.modeId);
      f.calls.push(`mode ${c.params.modeId}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (c) => {
      f.configs.push(`${c.params.configId}=${String(c.params.value)}`);
      f.calls.push(`config ${c.params.configId}=${String(c.params.value)}`);
      if (c.params.configId === "model") f.model = String(c.params.value);
      else if (c.params.configId === "mode") agentMode = String(c.params.value);
      else f.effort = String(c.params.value);
      // the reply is the whole list, rebuilt: a model without effort takes that option away
      return { configOptions: configOptions() };
    })
    .onRequest(acp.methods.agent.session.prompt, (c) => {
      f.prompts.push(c.params);
      return f.script(c.params, c.client);
    })
    .onRequest(acp.methods.agent.session.close, (c) => {
      f.calls.push(`close ${c.params.sessionId}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.delete, (c) => {
      f.calls.push(`delete ${c.params.sessionId}`);
      return {};
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

function world(
  fake: FakeAgent,
  spec = claudeSpec,
  idleMs = 60_000,
  id = `w${Math.random().toString(36).slice(2, 8)}`,
  extra: Partial<AcpSessionDeps> = {},
) {
  const events: AgentEvent[] = [];
  const statuses: AgentStatus[] = [];
  const auths: Array<[string, AuthObservation]> = [];
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
    attachments: new AttachmentStore(join(home, "attachments")),
    getSessionId: () => sessionId,
    setSessionId: (s) => {
      sessionId = s;
    },
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onAuth: (agentId, o) => auths.push([agentId, o]),
    idleMs,
    prepare: async () => ({ bounds, env: {} }),
    ...extra,
  });
  const idle = async () => {
    for (let i = 0; i < 200 && (session.status === "working" || session.queueLength > 0); i++) await Bun.sleep(5);
  };
  const types = () => events.map((e) => e.type);
  return { session, events, statuses, auths, types, idle, links, sessionId: () => sessionId, id };
}

describe("AcpSession", () => {
  test("a turn: user-message, turn-start, session-info, deltas, turn-end; transcript on disk; status back to idle", async () => {
    const fake = fakeAgent(say("hello"));
    const w = world(fake);
    w.session.send("hi", { context: ["ctx"] });
    await w.idle();
    expect(w.types()).toEqual(["user-message", "turn-start", "session-info", "text-delta", "turn-end"]);
    expect(w.events[2]).toMatchObject({ sessionId: "s1", model: "test-model" });
    expect(w.events[4]).toMatchObject({ stopReason: "end_turn" });
    expect(w.statuses).toEqual(["working", "idle"]);
    // context reaches the prompt, wrapped as Toyon's, but never the transcript
    expect(fake.prompts[0]!.prompt).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "[Attached by Toyon:\nctx]" },
    ]);
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

  test("where the preview stands rides after the message's own context, in one block, read as the prompt goes out", async () => {
    const fake = fakeAgent(say("ok"));
    let standing: string | undefined = "preview one";
    const w = world(fake, claudeSpec, 60_000, undefined, { preview: () => standing });
    w.session.send("hi", { context: ["ctx"] });
    await w.idle();
    standing = "preview two";
    w.session.send("again");
    await w.idle();
    expect(fake.prompts.map((p) => p.prompt.map((b) => (b as { text: string }).text))).toEqual([
      ["hi", "[Attached by Toyon:\nctx\n\npreview one]"],
      ["again", "[Attached by Toyon:\npreview two]"],
    ]);
    await w.session.close();
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

  test("an agent that steers takes a mid-turn message into the running turn, not the queue", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = fakeAgent(
      async (p, client) => {
        await gate;
        return say("done")(p, client);
      },
      { steering: true },
    );
    const w = world(fake);
    w.session.send("one");
    await Bun.sleep(20);
    w.session.send("two");
    await Bun.sleep(20);
    // it went out, so there is nothing waiting and nothing to unqueue
    expect(w.session.queueItems).toEqual([]);
    expect(fake.steers).toHaveLength(1);
    expect(fake.steers[0]!.prompt).toEqual([{ type: "text", text: "two" }]);
    expect(fake.steers[0]!.sessionId).toBe("s1");
    // the message is shown where it was sent; the turn it joined still starts and ends once
    expect(w.types()).toEqual(["user-message", "turn-start", "session-info", "user-message"]);
    release();
    await w.idle();
    expect(fake.prompts).toHaveLength(1);
    expect(w.types().filter((t) => t === "turn-start")).toHaveLength(1);
    expect(w.types().filter((t) => t === "turn-end")).toHaveLength(1);
    await w.session.close();
  });

  test("a steered message the agent hands back runs as its own turn, shown once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = fakeAgent(
      async (p, client) => {
        if ((p.prompt[0] as { text: string }).text === "one") await gate;
        return say("done")(p, client);
      },
      { steering: true },
    );
    fake.steerOutcome = "promptRequired";
    const w = world(fake);
    w.session.send("one");
    await Bun.sleep(20);
    w.session.send("two");
    await Bun.sleep(20);
    expect(fake.steers).toHaveLength(1);
    // waiting, but already a bubble in the log, so not drawn as queued
    expect(w.session.queueLength).toBe(1);
    expect(w.session.queueItems).toEqual([]);
    release();
    await w.idle();
    expect(fake.prompts.map((p) => (p.prompt[0] as { text: string }).text)).toEqual(["one", "two"]);
    // recorded on the way to the steer, not again on the way to the prompt
    expect(w.types().filter((t) => t === "user-message")).toHaveLength(2);
    await w.session.close();
  });

  test("a steering request that fails sends the message as a prompt instead", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = fakeAgent(
      async (p, client) => {
        if ((p.prompt[0] as { text: string }).text === "one") await gate;
        return say("done")(p, client);
      },
      { steering: true },
    );
    fake.steerError = true;
    const w = world(fake);
    w.session.send("one");
    await Bun.sleep(20);
    w.session.send("two");
    await Bun.sleep(20);
    expect(w.session.queueLength).toBe(1);
    expect(w.session.queueItems).toEqual([]);
    release();
    await w.idle();
    expect(fake.prompts.map((p) => (p.prompt[0] as { text: string }).text)).toEqual(["one", "two"]);
    expect(w.types().filter((t) => t === "user-message")).toHaveLength(2);
    await w.session.close();
  });

  test("a turn the agent started for itself is left to it, not sent again", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = fakeAgent(
      async (p, client) => {
        await gate;
        return say("done")(p, client);
      },
      { steering: true },
    );
    fake.steerOutcome = "startedNewTurn";
    const w = world(fake);
    w.session.send("one");
    await Bun.sleep(20);
    w.session.send("two");
    await Bun.sleep(20);
    release();
    await w.idle();
    expect(w.session.queueItems).toEqual([]);
    expect(fake.prompts).toHaveLength(1);
    await w.session.close();
  });

  /** an agent whose turn on "go" runs until it is cancelled, saying something about a steered
   * message if `answer`; anything else it answers straight away */
  const untilCancelled = ({ answer, ...opts }: { steering?: boolean; answer?: boolean } = {}) => {
    const fake = fakeAgent(async (p, client) => {
      if ((p.prompt[0] as { text: string }).text !== "go") return say("done")(p, client);
      let answered = false;
      while (fake.cancels === 0) {
        if (answer && !answered && fake.steers.length > 0) {
          answered = true;
          await say("on it")(p, client);
        }
        await Bun.sleep(5);
      }
      return { stopReason: "cancelled" };
    }, opts);
    return fake;
  };
  const promptTexts = (f: FakeAgent) => f.prompts.map((p) => (p.prompt[0] as { text: string }).text);

  test("stop() cancels the turn, which ends as interrupted, and the queue goes next", async () => {
    const stopping = untilCancelled();
    const w = world(stopping);
    w.session.send("go");
    w.session.send("later");
    await Bun.sleep(30);
    expect(w.session.status).toBe("working");
    w.session.stop();
    await w.idle();
    expect(stopping.cancels).toBe(1);
    expect(w.session.queueItems).toEqual([]);
    expect(stopping.prompts.map((p) => (p.prompt[0] as { text: string }).text)).toEqual(["go", "later"]);
    expect(w.events.filter((e) => e.type === "turn-end")).toMatchObject([
      { stopReason: "interrupted" },
      { stopReason: "end_turn" },
    ]);
    await w.session.close();
  });

  test("a stop before the prompt has gone out keeps it from going, and the queue still runs", async () => {
    const stopping = untilCancelled();
    const w = world(stopping);
    w.session.send("go");
    w.session.send("later");
    // the agent is still starting: there is no turn on its side for a cancel to reach
    w.session.stop();
    await w.idle();
    expect(promptTexts(stopping)).toEqual(["later"]);
    expect(w.events.filter((e) => e.type === "turn-end")).toMatchObject([
      { stopReason: "interrupted" },
      { stopReason: "end_turn" },
    ]);
    expect(w.session.status).toBe("idle");
    await w.session.close();
  });

  test("a message sent while a stop settles runs once the turn has ended, not into the cancelled one", async () => {
    const stopping = untilCancelled({ steering: true });
    const w = world(stopping);
    w.session.send("go");
    await Bun.sleep(30);
    w.session.stop();
    w.session.send("next");
    await w.idle();
    expect(stopping.steers).toHaveLength(0);
    expect(promptTexts(stopping)).toEqual(["go", "next"]);
    expect(w.session.status).toBe("idle");
    await w.session.close();
  });

  test("a steered message the agent had not answered when stopped runs as the next turn, shown once", async () => {
    const stopping = untilCancelled({ steering: true });
    const w = world(stopping);
    w.session.send("go");
    await Bun.sleep(30);
    w.session.send("also");
    await Bun.sleep(30);
    expect(stopping.steers).toHaveLength(1);
    w.session.send("then");
    await Bun.sleep(30);
    w.session.stop();
    // both are bubbles in the log already, so neither is drawn as queued while it waits
    expect(w.session.queueLength).toBe(2);
    expect(w.session.queueItems).toEqual([]);
    await w.idle();
    // in the order they were sent, the bubbles where they already are
    expect(promptTexts(stopping)).toEqual(["go", "also", "then"]);
    expect(w.types().filter((t) => t === "user-message")).toHaveLength(3);
    expect(w.session.status).toBe("idle");
    await w.session.close();
  });

  test("beside a handed-back steer, a message sent after the stop is the queued one, and unqueue takes it", async () => {
    const stopping = untilCancelled({ steering: true });
    const w = world(stopping);
    w.session.send("go");
    await Bun.sleep(30);
    w.session.send("also");
    await Bun.sleep(30);
    w.session.stop();
    w.session.send("next");
    expect(w.session.queueItems).toEqual(["next"]);
    w.session.unqueue(0);
    await w.idle();
    expect(promptTexts(stopping)).toEqual(["go", "also"]);
    await w.session.close();
  });

  test("a steered message the agent had started answering stays with the turn a stop ends", async () => {
    const stopping = untilCancelled({ steering: true, answer: true });
    const w = world(stopping);
    w.session.send("go");
    await Bun.sleep(30);
    w.session.send("also");
    await Bun.sleep(40);
    w.session.stop();
    await w.idle();
    expect(promptTexts(stopping)).toEqual(["go"]);
    expect(w.session.queueItems).toEqual([]);
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

  test("a network ask's row ends with its answer, since no tool runs behind it to end it", async () => {
    const host = "registry.npmjs.org";
    const fake = fakeAgent(async (p, client) => {
      await client.notify(acp.methods.client.session.update, {
        sessionId: p.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "n1",
          name: "SandboxNetworkAccess",
          title: "SandboxNetworkAccess",
          kind: "other",
          status: "pending",
          rawInput: { host },
        },
      });
      await client.request(acp.methods.client.session.requestPermission, {
        sessionId: p.sessionId,
        toolCall: { toolCallId: "n1", name: "SandboxNetworkAccess", title: host, kind: "other", rawInput: { host } },
        options: [
          { optionId: "yes", name: "Yes", kind: "allow_once" },
          { optionId: "no", name: "No", kind: "reject_once" },
        ],
      });
      return { stopReason: "end_turn" };
    });
    const w = world(fake);
    w.session.send("install");
    await w.idle();
    expect(w.events.filter((e) => "toolId" in e && e.toolId === "n1")).toEqual([
      { type: "tool-start", toolId: "n1", name: "", input: { host }, kind: "fetch", title: host },
      { type: "tool-end", toolId: "n1", output: "allowed", isError: false },
    ]);
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

  test("the command list pushed from inside session/new still lands: `live` is null when it arrives", async () => {
    const review = { name: "review", description: "review a PR", input: { hint: "<pr>" } };
    const fake = fakeAgent(say("ok"), { commands: { s1: [review] } });
    const w = world(fake);
    const seen: AgentCommand[][] = [];
    w.session.onCommandsChange = (c) => seen.push(c);
    w.session.send("hi");
    await w.idle();
    expect(w.session.commands).toEqual([{ name: "review", description: "review a PR", hint: "<pr>" }]);
    expect(seen).toHaveLength(1);
    await w.session.close();
  });

  test("an ask session's commands never clobber the worktree's", async () => {
    const fake = fakeAgent(say("ok"), {
      commands: { s1: [{ name: "review", description: "mine" }], s2: [{ name: "namer", description: "theirs" }] },
    });
    const w = world(fake);
    w.session.send("hi");
    await w.idle();
    expect(w.session.commands.map((c) => c.name)).toEqual(["review"]);
    // the ask session pushes its list before askOnce has registered the id, which is the race
    await w.session.ask("be brief", "name this");
    expect(fake.newSessions).toHaveLength(2);
    expect(w.session.commands.map((c) => c.name)).toEqual(["review"]);
    await w.session.close();
  });

  test("a worktree serves the seeded list before its own agent has ever run", async () => {
    const seed = [{ name: "review", description: "from the last worktree on this repo" }];
    const fake = fakeAgent(say("ok"), { commands: { s1: [{ name: "ship", description: "its own" }] } });
    const learned: AgentCommand[][] = [];
    const w = world(fake, claudeSpec, 60_000, `w${Math.random().toString(36).slice(2, 8)}`, {
      seedCommands: () => seed,
      onCommandsLearned: (c) => learned.push(c),
    });
    // no prompt sent yet, so no adapter process exists
    expect(w.session.commands).toEqual(seed);
    w.session.send("hi");
    await w.idle();
    // the agent's own list replaces the seed, and is kept for the next worktree
    expect(w.session.commands.map((c) => c.name)).toEqual(["ship"]);
    expect(learned).toEqual([[{ name: "ship", description: "its own" }]]);
    await w.session.close();
  });

  test("warmCommands starts the session so the menu has something before the first message", async () => {
    const fake = fakeAgent(say("ok"), { commands: { s1: [{ name: "review", description: "look" }] } });
    const w = world(fake);
    expect(w.session.commands).toEqual([]);
    await w.session.warmCommands();
    expect(w.session.commands.map((c) => c.name)).toEqual(["review"]);
    // it started a session but no turn: nothing was said on the worktree's behalf
    expect(fake.prompts).toHaveLength(0);
    expect(w.types()).toEqual(["session-info"]);
    await w.session.close();
  });

  test("warmCommands does nothing once the list is known, and swallows an agent that will not start", async () => {
    const fake = fakeAgent(say("ok"), { commands: { s1: [{ name: "review", description: "look" }] } });
    const w = world(fake);
    await w.session.warmCommands();
    await w.session.warmCommands();
    expect(fake.newSessions).toHaveLength(1);
    await w.session.close();
  });

  test("the command list survives the reaper, so `/` still works with no process running", async () => {
    const fake = fakeAgent(say("ok"), { commands: { s1: [{ name: "review", description: "mine" }] } });
    const w = world(fake, claudeSpec, 10);
    w.session.send("first");
    await w.idle();
    for (let i = 0; i < 100 && !w.links[0]!.killed; i++) await Bun.sleep(5);
    expect(w.links[0]!.killed).toBe(true);
    expect(w.session.commands.map((c) => c.name)).toEqual(["review"]);
    await w.session.close();
  });

  test("the reaper kills an idle process; the next prompt respawns and resumes via session/resume, never session/load", async () => {
    const fake = fakeAgent(say("again"));
    const w = world(fake, claudeSpec, 10);
    w.session.send("first");
    await w.idle();
    for (let i = 0; i < 100 && !w.links[0]!.killed; i++) await Bun.sleep(5);
    expect(w.links[0]!.killed).toBe(true);
    w.session.send("second");
    await w.idle();
    expect(w.links).toHaveLength(2);
    expect(fake.resumes).toHaveLength(1);
    expect(fake.resumes[0]!.sessionId).toBe("s1");
    expect(fake.loads).toHaveLength(0);
    expect(fake.newSessions).toHaveLength(1);
    expect(w.events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text)).toEqual([
      "again",
      "again",
    ]);
    expect(w.sessionId()).toBe("s1");
    await w.session.close();
  });

  test("a failed session/resume falls back to session/new and the stored id moves on", async () => {
    const fake = fakeAgent(say("x"));
    const w = world(fake, claudeSpec, 10);
    w.session.send("first");
    await w.idle();
    for (let i = 0; i < 100 && !w.links[0]!.killed; i++) await Bun.sleep(5);
    fake.failResume = true;
    w.session.send("second");
    await w.idle();
    expect(fake.resumes).toHaveLength(1);
    expect(fake.loads).toHaveLength(0);
    expect(fake.newSessions).toHaveLength(2);
    expect(w.sessionId()).toBe("s2");
    expect(w.session.status).toBe("idle");
    await w.session.close();
  });

  test("an agent without session/resume starts a new session after a reap rather than replaying", async () => {
    const fake = fakeAgent(say("x"), { resumeSession: false });
    const w = world(fake, claudeSpec, 10);
    w.session.send("first");
    await w.idle();
    for (let i = 0; i < 100 && !w.links[0]!.killed; i++) await Bun.sleep(5);
    w.session.send("second");
    await w.idle();
    expect(fake.resumes).toHaveLength(0);
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
    expect(await w.session.authenticate("claude-login")).toMatchObject({
      kind: "terminal",
      run: { command: "/bin/agent", args: ["run.js", "--cli", "auth", "login"] },
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

  test("a terminal-auth _meta login runs the agent's binary with its own args, not the adapter's command line", async () => {
    const fake = fakeAgent(
      async () => {
        throw acp.RequestError.authRequired();
      },
      { authMeta: true },
    );
    // the adapter starts as `/bin/agent run.js`, the world's stubbed launch; run.js is what makes it an adapter
    const w = world(fake, { ...codexSpec, run: { kind: "command", command: "/bin/agent", args: ["run.js"] } });
    w.session.send("a");
    await w.idle();
    // the login is only offered to a client that says it can run one
    expect(fake.inits[0]?.clientCapabilities?._meta).toEqual({ "terminal-auth": true });
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-auth-required" }>;
    expect(card.methods).toContainEqual({ id: "opencode-login", name: "Login with opencode", kind: "terminal" });
    expect(await w.session.authenticate("opencode-login")).toMatchObject({
      kind: "terminal",
      run: { command: "/bin/agent", args: ["auth", "login"] },
    });
    await w.session.close();
  });

  test("a spec's own login for a method replaces the adapter's arguments and adds its environment", async () => {
    const fake = fakeAgent(
      async () => {
        throw acp.RequestError.authRequired();
      },
      { authMeta: true },
    );
    const w = world(fake, {
      ...codexSpec,
      run: { kind: "command", command: "/bin/agent", args: ["run.js"] },
      terminalLogins: { "opencode-login": { args: ["--cli", "auth", "login"], env: { NO_BROWSER: "1" } } },
    });
    w.session.send("a");
    await w.idle();
    const out = await w.session.authenticate("opencode-login");
    expect(out).toMatchObject({
      kind: "terminal",
      run: { command: "/bin/agent", args: ["run.js", "--cli", "auth", "login"], env: { NO_BROWSER: "1" } },
    });
    // the card closes and the refused message goes again only once the login says it finished
    expect(w.types()).not.toContain("agent-auth-ok");
    w.session.loggedIn();
    expect(w.types()).toContain("agent-auth-ok");
    await w.session.close();
  });

  test("a refused credential also becomes an auth card, after the provider's own words", async () => {
    let failures = 1;
    const fake = fakeAgent(async (p, client) => {
      // what an adapter passes on when the provider rejects the key it is holding: no ACP auth
      // code, just the turn failing with a 401
      if (failures-- > 0)
        throw new acp.RequestError(-32603, "unexpected status 401 Unauthorized: Incorrect API key provided: sk-bogus");
      return say("ok")(p, client);
    });
    fake.app.onRequest(acp.methods.agent.authenticate, () => ({}));
    const w = world(fake);
    w.session.send("a");
    await w.idle();
    expect(w.session.status).toBe("error");
    // the error stays: an agent that thinks it is logged in must not be contradicted silently
    const err = w.events.at(-2) as Extract<AgentEvent, { type: "agent-error" }>;
    expect(err.type).toBe("agent-error");
    expect(err.message).toContain("401");
    expect(w.events.at(-1)).toMatchObject({ type: "agent-auth-required", rejected: true, agentName: "Claude" });
    // the process stays up, so the login runs over it and the refused message goes again
    expect(w.links[0]!.killed).toBe(false);
    expect(await w.session.authenticate("api-key", "sk-good")).toEqual({ kind: "done" });
    await w.idle();
    expect(w.session.status).toBe("idle");
    expect(w.types().filter((ty) => ty === "user-message")).toHaveLength(2);
    await w.session.close();
  });

  test("a failure that only mentions permission is not read as a credential problem", async () => {
    const fake = fakeAgent(async () => {
      throw new acp.RequestError(-32603, "403 Forbidden: your organization must enable this model");
    });
    const w = world(fake);
    w.session.send("a");
    await w.idle();
    expect(w.events.at(-1)).toMatchObject({ type: "agent-error" });
    expect(w.types()).not.toContain("agent-auth-required");
    await w.session.close();
  });

  test("the agent's logout capability and the identity it pushes are reported once per connection", async () => {
    const fake = fakeAgent(say("ok"), {
      logout: true,
      authStatus: { kind: "account", label: "Claude Max", account: { email: "who@example.com" } },
    });
    const w = world(fake);
    w.session.send("a");
    await w.idle();
    expect(w.auths).toEqual([
      ["claude", { status: { kind: "account", label: "Claude Max", account: { email: "who@example.com" } } }],
      ["claude", { canLogout: true }],
    ]);
    await w.session.close();
  });

  test("an agent that reports neither is left alone", async () => {
    const fake = fakeAgent(say("ok"));
    const w = world(fake);
    w.session.send("a");
    await w.idle();
    expect(w.auths).toEqual([["claude", { canLogout: false }]]);
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

  test("an adapter's internal-error label is not part of the message", async () => {
    const fake = fakeAgent(async () => {
      throw new acp.RequestError(-32603, "Internal error: You've hit your monthly spend limit");
    });
    const w = world(fake);
    w.session.send("a");
    await w.idle();
    expect(w.events.at(-1)).toMatchObject({ type: "agent-error", message: "You've hit your monthly spend limit" });
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

  const png = {
    kind: "image" as const,
    name: "shot.png",
    mimeType: "image/png" as const,
    data: Buffer.from("PNG").toString("base64"),
    width: 8,
    height: 4,
  };
  const paste = (text: string, name?: string) => ({ kind: "paste" as const, text, ...(name ? { name } : {}) });
  const pick = {
    kind: "pick" as const,
    component: "Button",
    file: "src/ui/Button.tsx",
    line: 3,
    callFile: null,
    callLine: null,
    tag: "button",
    selector: "main > button",
    text: "Save",
    html: "<button>Save</button>",
  };

  test("images: stored, numbered per session, captioned ahead of the text; numbering survives a restart", async () => {
    const fake = fakeAgent(say("ok"), { images: true });
    const w = world(fake);
    w.session.send("what is this", { context: ["ctx"], attachments: [png, { ...png, name: "two.png" }] });
    await w.idle();
    expect(w.events[0]).toMatchObject({
      type: "user-message",
      text: "what is this",
      attachments: [
        { kind: "image", n: 1, name: "shot.png", file: "1.png", bytes: 3, width: 8, height: 4 },
        { kind: "image", n: 2, name: "two.png", file: "2.png" },
      ],
    });
    expect(fake.prompts[0]!.prompt).toEqual([
      { type: "text", text: "Image 1: shot.png (8×4)" },
      { type: "image", mimeType: "image/png", data: "UE5H" },
      { type: "text", text: "Image 2: two.png (8×4)" },
      { type: "image", mimeType: "image/png", data: "UE5H" },
      { type: "text", text: "what is this" },
      { type: "text", text: "[Attached by Toyon:\nctx]" },
    ]);
    expect(readFileSync(join(home, "attachments", w.id, "2.png"), "utf8")).toBe("PNG");
    await w.session.close();
    // a new AcpSession over the same transcript continues the count: "image 3" is unambiguous
    const w2 = world(fake, claudeSpec, 60_000, w.id);
    w2.session.send("and this", { attachments: [png] });
    await w2.idle();
    expect(w2.events[0]).toMatchObject({ type: "user-message", attachments: [{ kind: "image", n: 3, file: "3.png" }] });
    await w2.session.close();
  });

  test("kinds are numbered apart and keep the order they were attached in, in the bubble and the prompt", async () => {
    const fake = fakeAgent(say("ok"), { images: true });
    const w = world(fake);
    w.session.send("this one", { attachments: [pick, paste("a"), { ...pick, selector: "nav" }, png] });
    await w.idle();
    expect(w.events[0]).toMatchObject({
      type: "user-message",
      attachments: [
        { kind: "pick", n: 1, selector: "main > button" },
        { kind: "paste", n: 1, file: "1.txt" },
        { kind: "pick", n: 2, selector: "nav" },
        { kind: "image", n: 1, file: "1.png" },
      ],
    });
    const heads = (fake.prompts[0]!.prompt as Array<{ type: string; text?: string }>).map(
      (b) =>
        b.text?.match(/^(An element the user picked in the preview: <\w+ \/>|Pasted text \d+|Image \d+)/)?.[0] ??
        b.text ??
        b.type,
    );
    const element = "An element the user picked in the preview: <Button />";
    expect(heads).toEqual([element, "Pasted text 1", element, "Image 1", "image", "this one"]);
    await w.session.close();
  });

  test("pastes: stored as .txt, numbered per session, fenced ahead of the text", async () => {
    const fake = fakeAgent(say("ok"));
    const w = world(fake);
    w.session.send("fix this", { attachments: [paste("one\ntwo"), paste("x", "App.tsx")] });
    await w.idle();
    expect(w.events[0]).toMatchObject({
      type: "user-message",
      text: "fix this",
      attachments: [
        { kind: "paste", n: 1, chars: 7, lines: 2, preview: "one", file: "1.txt" },
        { kind: "paste", n: 2, name: "App.tsx", file: "2.txt" },
      ],
    });
    expect(readFileSync(join(home, "attachments", w.id, "1.txt"), "utf8")).toBe("one\ntwo");
    const blocks = fake.prompts[0]!.prompt as Array<{ text: string }>;
    expect(blocks[0]!.text).toBe(
      "Pasted text 1 (2 lines, 7 chars), begins: one\n<pasted-text 1>\none\ntwo\n</pasted-text>",
    );
    expect(blocks[2]!.text).toBe("fix this");
    // numbering continues over a restart, so "pasted text 3" still means the same block
    await w.session.close();
    const w2 = world(fake, claudeSpec, 60_000, w.id);
    w2.session.send("and this", { attachments: [paste("z")] });
    await w2.idle();
    expect(w2.events[0]).toMatchObject({ type: "user-message", attachments: [{ kind: "paste", n: 3, file: "3.txt" }] });
    await w2.session.close();
  });

  test("an agent without image support gets the text only, and the person is told", async () => {
    const fake = fakeAgent(say("ok"));
    const w = world(fake);
    w.session.send("look", { attachments: [png] });
    await w.idle();
    expect(w.types()).toEqual(["user-message", "turn-start", "session-info", "agent-error", "text-delta", "turn-end"]);
    expect(w.events[3]).toMatchObject({ message: "Claude does not accept images; the message went without it" });
    expect(fake.prompts[0]!.prompt).toEqual([{ type: "text", text: "look" }]);
    expect(w.statuses).toEqual(["working", "idle"]);
    await w.session.close();
  });

  test("ask() runs a side session with its own system prompt in a read-only mode; the main transcript is untouched", async () => {
    const fake = fakeAgent(
      async (p, client) => {
        const text = (p.prompt[0] as { text: string }).text;
        return say(text.startsWith("Name") ? "sticky-header" : "main reply")(p, client);
      },
      { withModes: true, currentMode: "agent" },
    );
    const w = world(fake, claudeSpec, 10);
    expect(await w.session.ask("You name things.", "Name this: sticky header")).toBe("sticky-header");
    // the question ran on a session of its own with its own system prompt, switched to the
    // read-only mode, and wrote nothing to the transcript; no chat session was opened for it
    expect(fake.newSessions).toHaveLength(1);
    expect(fake.newSessions[0]!._meta).toEqual({ systemPrompt: "You name things." });
    expect(fake.modes).toEqual(["read-only"]);
    expect(w.events).toEqual([]);
    // the chat session opens on the same process when the first prompt arrives
    w.session.send("hello");
    await w.idle();
    expect(fake.newSessions).toHaveLength(2);
    expect(w.links).toHaveLength(1);
    expect(w.events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text)).toEqual([
      "main reply",
    ]);
    // the reaper was armed after the question and again after the turn
    for (let i = 0; i < 100 && !w.links[0]!.killed; i++) await Bun.sleep(5);
    expect(w.links[0]!.killed).toBe(true);
    await w.session.close();
  });

  test("a side session's permission request is refused quietly: no card, no blocked row, no status change", async () => {
    const answers: string[] = [];
    const fake = fakeAgent(async (p, client) => {
      if (p.sessionId === "s1") return say("hi")(p, client);
      const r = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: p.sessionId,
        toolCall: { toolCallId: "t", title: "Edit", kind: "edit", locations: [{ path: join(wt, "ok.ts") }] },
        options: [
          { optionId: "allow-once", name: "a", kind: "allow_once" },
          { optionId: "reject", name: "r", kind: "reject_once" },
        ],
      });
      answers.push(r.outcome.outcome === "selected" ? r.outcome.optionId : "cancelled");
      return say("done")(p, client);
    });
    const w = world(fake);
    w.session.send("go");
    await w.idle();
    const events = w.events.length;
    const statuses = [...w.statuses];
    expect(await w.session.ask("sys", "name this")).toBe("done");
    // the chat runs in auto, where this edit would pass; a question nobody watches may only read
    expect(answers).toEqual(["reject"]);
    expect(w.events).toHaveLength(events);
    expect(w.statuses).toEqual(statuses);
    await w.session.close();
  });

  test("a side session carries the agent's side _meta and is closed, then deleted, when the agent offers both", async () => {
    const fake = fakeAgent(say("sticky-header"), { caps: { close: true, delete: true } });
    const sideMeta = { claudeCode: { options: { tools: [], persistSession: false } } };
    const w = world(fake, { ...claudeSpec, sideMeta });
    expect(await w.session.ask("You name things.", "Name this")).toBe("sticky-header");
    expect(fake.newSessions[0]!._meta).toEqual({ ...sideMeta, systemPrompt: "You name things." });
    for (let i = 0; i < 100 && fake.calls.length < 2; i++) await Bun.sleep(5);
    expect(fake.calls).toEqual(["close s1", "delete s1"]);
    await w.session.close();
  });

  test("a side session on an agent without close or delete is left for the process to end", async () => {
    const fake = fakeAgent(say("ok"));
    const w = world(fake, codexSpec);
    expect(await w.session.ask("sys", "q")).toBe("ok");
    await Bun.sleep(20);
    expect(fake.calls).toEqual([]);
    // a prompt-prefix agent with no side _meta sends none at all
    expect(fake.newSessions[0]!._meta).toBeUndefined();
    await w.session.close();
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

// A form shaped the way @agentclientprotocol/claude-agent-acp bridges AskUserQuestion.
const askForm = (opts: { note?: boolean; multi?: boolean } = {}) => ({
  mode: "form" as const,
  message: "Which auth approach?",
  toolCallId: "t1",
  requestedSchema: {
    type: "object" as const,
    properties: {
      question_0: opts.multi
        ? {
            type: "array" as const,
            title: "Auth",
            items: {
              anyOf: [
                { const: "a", title: "A" },
                { const: "b", title: "B" },
              ],
            },
          }
        : {
            type: "string" as const,
            title: "Auth",
            oneOf: [
              { const: "a", title: "A" },
              { const: "b", title: "B" },
            ],
          },
      ...(opts.note
        ? {
            question_0_custom: {
              type: "string" as const,
              title: "Other",
              _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } },
            },
          }
        : {}),
    },
  },
});

/** a turn that asks one question and then reports whatever came back */
const asks =
  (form: unknown = askForm({ note: true })): PromptScript =>
  async (p, client) => {
    const answer = await client.request(acp.methods.client.elicitation.create, {
      sessionId: p.sessionId,
      ...(form as object),
    } as acp.CreateElicitationRequest);
    await client.notify(acp.methods.client.session.update, {
      sessionId: p.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(answer) } },
    });
    return { stopReason: "end_turn" };
  };

/** the id of the card the session most recently opened */
const openAsk = (events: AgentEvent[]) =>
  (events.findLast((e) => e.type === "agent-question" || e.type === "agent-permission") as { id: string } | undefined)
    ?.id;

const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await Bun.sleep(5);
};

const saidBack = (events: AgentEvent[]) =>
  JSON.parse((events.find((e) => e.type === "text-delta") as { text: string }).text);

describe("AcpSession ask cards", () => {
  test("initialize advertises form elicitation, which is what un-hides the agent's ask tool", async () => {
    const fake = fakeAgent(say("hi"));
    const w = world(fake);
    w.session.send("go");
    await w.idle();
    expect(fake.inits[0]!.clientCapabilities?.elicitation).toEqual({ form: {} });
    await w.session.close();
  });

  test("a question blocks the turn, and the answer goes back in the agent's own field names", async () => {
    const fake = fakeAgent(asks());
    const w = world(fake);
    w.session.send("go");
    await waitFor(() => !!openAsk(w.events));
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-question" }>;
    expect(card).toMatchObject({ type: "agent-question", message: "Which auth approach?", toolId: "t1" });
    expect(card.questions).toEqual([
      {
        id: "question_0",
        text: "",
        header: "Auth",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        note: { label: "Other" },
      },
    ]);
    // nothing has ended the turn, and the worktree reads as waiting on a person rather than busy
    expect(w.types()).not.toContain("turn-end");
    expect(w.session.status).toBe("waiting");

    w.session.answer(card.id, {
      kind: "answers",
      answers: [{ selected: ["a"], note: "only if it stays server-side" }],
    });
    await w.idle();
    expect(w.types()).toContain("turn-end");
    expect(w.events.find((e) => e.type === "agent-ask-end")).toMatchObject({ id: card.id, outcome: "answered" });
    // the note rides with the pick, so the agent reads the choice and the caveat together
    expect(saidBack(w.events)).toEqual({
      action: "accept",
      content: { question_0: "a", question_0_custom: "A: only if it stays server-side" },
    });
    expect(w.statuses).toEqual(["working", "waiting", "working", "idle"]);
    await w.session.close();
  });

  test("skipping declines, which the agent hears as the person passing rather than as a failure", async () => {
    const fake = fakeAgent(asks());
    const w = world(fake);
    w.session.send("go");
    await waitFor(() => !!openAsk(w.events));
    w.session.answer(openAsk(w.events)!, { kind: "answers" });
    await w.idle();
    expect(w.events.find((e) => e.type === "agent-ask-end")).toMatchObject({ outcome: "skipped" });
    expect(saidBack(w.events)).toEqual({ action: "decline" });
    await w.session.close();
  });

  test("stopping the turn cancels the card instead of leaving the agent blocked on it", async () => {
    const fake = fakeAgent(asks());
    const w = world(fake);
    w.session.send("go");
    await waitFor(() => !!openAsk(w.events));
    w.session.stop();
    await w.idle();
    expect(w.events.find((e) => e.type === "agent-ask-end")).toMatchObject({ outcome: "cancelled" });
    expect(w.types()).toContain("turn-end");
    await w.session.close();
  });

  test("answering an ask that already closed is a no-op, not a throw", async () => {
    const fake = fakeAgent(asks());
    const w = world(fake);
    w.session.send("go");
    await waitFor(() => !!openAsk(w.events));
    const id = openAsk(w.events)!;
    w.session.answer(id, { kind: "answers", answers: [{ selected: ["a"] }] });
    await w.idle();
    const ends = w.events.filter((e) => e.type === "agent-ask-end").length;
    // the second shell's click lands after the first one settled the card
    w.session.answer(id, { kind: "answers", answers: [{ selected: ["b"] }] });
    expect(w.events.filter((e) => e.type === "agent-ask-end")).toHaveLength(ends);
    await w.session.close();
  });

  test("a multi-select answer goes back as an array", async () => {
    const fake = fakeAgent(asks(askForm({ multi: true })));
    const w = world(fake);
    w.session.send("go");
    await waitFor(() => !!openAsk(w.events));
    w.session.answer(openAsk(w.events)!, { kind: "answers", answers: [{ selected: ["a", "b"] }] });
    await w.idle();
    expect(saidBack(w.events)).toEqual({ action: "accept", content: { question_0: ["a", "b"] } });
    await w.session.close();
  });

  test("a form toyon cannot draw as choices is declined without painting a card", async () => {
    const fake = fakeAgent(
      asks({
        mode: "form",
        message: "What is the port?",
        requestedSchema: { type: "object", properties: { port: { type: "number" } } },
      }),
    );
    const w = world(fake);
    w.session.send("go");
    await w.idle();
    expect(w.types()).not.toContain("agent-question");
    expect(saidBack(w.events)).toEqual({ action: "decline" });
    await w.session.close();
  });

  test("an elicitation on a side session is declined and never touches the worktree transcript", async () => {
    // the namer and the batch planner run on this same connection; a card there would appear in a
    // chat nobody was looking at, answering a question nobody asked for
    // the chat turn runs on s1; anything else here is a side session
    const fake = fakeAgent(async (p, client) => {
      if (p.sessionId === "s1") return say("hi")(p, client);
      const answer = await client.request(acp.methods.client.elicitation.create, {
        sessionId: p.sessionId,
        ...askForm(),
      } as acp.CreateElicitationRequest);
      await client.notify(acp.methods.client.session.update, {
        sessionId: p.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(answer) } },
      });
      return { stopReason: "end_turn" };
    });
    const w = world(fake);
    w.session.send("go");
    await w.idle();
    const before = w.events.length;
    const reply = await w.session.ask("sys", "name this");
    expect(JSON.parse(reply!)).toEqual({ action: "decline" });
    // and the worktree's own chat never heard about the question
    expect(w.events).toHaveLength(before);
    expect(w.types()).not.toContain("agent-question");
    await w.session.close();
  });

  test("a plan approval reaches a person instead of being allowed silently", async () => {
    const fake = fakeAgent(async (p, client) => {
      const outcome = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: p.sessionId,
        toolCall: {
          toolCallId: "t9",
          title: "Approve Plan",
          kind: "switch_mode",
          content: [{ type: "content", content: { type: "text", text: "# the plan\n\nstep one" } }],
        },
        options: [
          { optionId: "exit_plan_default", name: "Yes, manually approve edits", kind: "allow_once" },
          { optionId: "cancel", name: "No, keep planning", kind: "reject_once" },
        ],
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId: p.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(outcome) } },
      });
      return { stopReason: "end_turn" };
    });
    const w = world(fake);
    w.session.send("plan it");
    await waitFor(() => !!openAsk(w.events));
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-permission" }>;
    expect(card).toMatchObject({ type: "agent-permission", title: "Approve Plan", toolId: "t9" });
    expect(card.detail).toBe("# the plan\n\nstep one");
    expect(card.choices.map((c) => c.id)).toEqual(["exit_plan_default", "cancel"]);

    w.session.answer(card.id, { kind: "choice", choiceId: "cancel" });
    await w.idle();
    expect(saidBack(w.events)).toEqual({ outcome: { outcome: "selected", optionId: "cancel" } });
    await w.session.close();
  });

  test("the plan is written to the worktree, and the card names the file instead of carrying it", async () => {
    const fake = fakeAgent(async (p, client) => {
      await client.request(acp.methods.client.session.requestPermission, {
        sessionId: p.sessionId,
        toolCall: {
          toolCallId: "t1",
          title: "Approve Plan",
          kind: "switch_mode",
          content: [{ type: "content", content: { type: "text", text: "# the plan\n\nstep one" } }],
        },
        options: [
          { optionId: "exit_plan_default", name: "Yes, manually approve edits", kind: "allow_once" },
          { optionId: "cancel", name: "No, keep planning", kind: "reject_once" },
        ],
      });
      return { stopReason: "end_turn" };
    });
    const w = world(fake, claudeSpec, 60_000, undefined, { onPlan: (md) => writePlanDoc(wt, md) });
    w.session.send("plan it");
    await waitFor(() => !!openAsk(w.events));
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-permission" }>;
    expect(card.plan).toBe(PLAN_REL);
    expect(readFileSync(join(wt, PLAN_REL), "utf8")).toBe("# the plan\n\nstep one\n");
    // the markdown rides along too: a shell whose worktree could not take the file still shows it
    expect(card.detail).toBe("# the plan\n\nstep one");
    w.session.answer(card.id, { kind: "choice", choiceId: "cancel" });
    await w.idle();
    await w.session.close();
  });

  test("a plan rewritten before the yes sends the agent to the file, not to what it proposed", async () => {
    let turns = 0;
    const fake = fakeAgent(async (p, client) => {
      if (++turns > 1) return { stopReason: "end_turn" };
      await client.request(acp.methods.client.session.requestPermission, {
        sessionId: p.sessionId,
        toolCall: {
          toolCallId: "t2",
          title: "Approve Plan",
          kind: "switch_mode",
          content: [{ type: "content", content: { type: "text", text: "# the plan\n\nrewrite the world" } }],
        },
        options: [
          { optionId: "exit_plan_default", name: "Yes, manually approve edits", kind: "allow_once" },
          { optionId: "cancel", name: "No, keep planning", kind: "reject_once" },
        ],
      });
      return { stopReason: "end_turn" };
    });
    const w = world(fake, claudeSpec, 60_000, undefined, {
      onPlan: (md) => writePlanDoc(wt, md),
      planEdited: async (proposed) => planEdited(wt, proposed),
    });
    w.session.send("plan it");
    await waitFor(() => !!openAsk(w.events));
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-permission" }>;
    writeFileSync(join(wt, PLAN_REL), "# the plan\n\nrewrite one file\n");
    w.session.answer(card.id, { kind: "choice", choiceId: "exit_plan_default" });
    await waitFor(() => fake.prompts.length > 1);
    expect((fake.prompts.at(-1)!.prompt[0] as { text: string }).text).toContain(PLAN_REL);
    await w.session.close();
  });

  test("an approved plan nobody touched says nothing further to the agent", async () => {
    let turns = 0;
    const fake = fakeAgent(async (p, client) => {
      if (++turns > 1) return { stopReason: "end_turn" };
      await client.request(acp.methods.client.session.requestPermission, {
        sessionId: p.sessionId,
        toolCall: {
          toolCallId: "t3",
          title: "Approve Plan",
          kind: "switch_mode",
          content: [{ type: "content", content: { type: "text", text: "# the plan\n\nas proposed" } }],
        },
        options: [{ optionId: "exit_plan_default", name: "Yes, manually approve edits", kind: "allow_once" }],
      });
      return { stopReason: "end_turn" };
    });
    const w = world(fake, claudeSpec, 60_000, undefined, {
      onPlan: (md) => writePlanDoc(wt, md),
      planEdited: async (proposed) => planEdited(wt, proposed),
    });
    w.session.send("plan it");
    await waitFor(() => !!openAsk(w.events));
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-permission" }>;
    w.session.answer(card.id, { kind: "choice", choiceId: "exit_plan_default" });
    await w.idle();
    expect(fake.prompts).toHaveLength(1);
    await w.session.close();
  });

  test("Codex sends its plan as rawInput rather than content, and the card still has it", async () => {
    const fake = fakeAgent(async (p, client) => {
      const outcome = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: p.sessionId,
        toolCall: {
          toolCallId: "plan-1",
          title: "Implement this plan?",
          kind: "switch_mode",
          rawInput: { plan: "1. read\n2. write" },
        },
        options: [
          { optionId: "implement_plan", name: "Yes, implement this plan", kind: "allow_once" },
          { optionId: "revise_plan", name: "No, and tell Codex what to do differently", kind: "reject_once" },
        ],
      });
      await client.notify(acp.methods.client.session.update, {
        sessionId: p.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(outcome) } },
      });
      return { stopReason: "end_turn" };
    });
    const w = world(fake, codexSpec);
    w.session.send("plan it");
    await waitFor(() => !!openAsk(w.events));
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-permission" }>;
    expect(card.detail).toBe("1. read\n2. write");
    w.session.answer(card.id, { kind: "choice", choiceId: "implement_plan" });
    await w.idle();
    expect(saidBack(w.events)).toEqual({ outcome: { outcome: "selected", optionId: "implement_plan" } });
    await w.session.close();
  });

  test("a card the daemon died under is closed when the transcript is read back", async () => {
    const fake = fakeAgent(asks());
    const w = world(fake);
    w.session.send("go");
    await waitFor(() => !!openAsk(w.events));
    const id = openAsk(w.events)!;
    // deliberately not close(), which is a clean shutdown and cancels its own cards. Leaving the
    // card open puts a question with no end on disk, which is what a killed daemon leaves behind.
    await waitFor(() => readFileSync(join(home, `${w.id}.jsonl`), "utf8").includes(id));

    const revived = world(fakeAgent(say("hi")), claudeSpec, 60_000, w.id);
    expect(revived.events).toHaveLength(1);
    expect(revived.events[0]).toMatchObject({ type: "agent-ask-end", id, outcome: "expired" });
    // a second read adds nothing: that end event closed the card for good
    await waitFor(() => readFileSync(join(home, `${w.id}.jsonl`), "utf8").includes("expired"));
    const again = world(fakeAgent(say("hi")), claudeSpec, 60_000, w.id);
    expect(again.events).toHaveLength(0);
    await revived.session.close();
    await again.session.close();
    await w.session.close();
  });
});

// The worktree's permission mode: `ask` holds the agent's own requests as cards, `plan` puts the
// agent in its read-only mode before a prompt, and approving a plan decides the mode after it.
describe("AcpSession permission modes", () => {
  const editRequest = (p: acp.PromptRequest, path: string): acp.RequestPermissionRequest => ({
    sessionId: p.sessionId,
    toolCall: {
      toolCallId: "t-edit",
      title: "Edit a.ts",
      kind: "edit",
      locations: [{ path }],
      content: [{ type: "diff", path, oldText: "a", newText: "b\nc" }],
    },
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "allow-with-updates", name: "Always", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });

  test("ask: an inside edit is a card without the always option, and the answer reaches the agent", async () => {
    const fake = fakeAgent(async (p, client) => {
      const r = await client.request(acp.methods.client.session.requestPermission, editRequest(p, join(wt, "a.ts")));
      await client.notify(acp.methods.client.session.update, {
        sessionId: p.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(r) } },
      });
      return { stopReason: "end_turn" };
    });
    const w = world(fake, claudeSpec, 60_000, undefined, { mode: () => "ask" });
    w.session.send("edit");
    await waitFor(() => !!openAsk(w.events));
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-permission" }>;
    expect(card.title).toBe("Edit a.ts");
    expect(card.choices.map((c) => c.id)).toEqual(["allow-once", "reject"]);
    expect(card.detail).toContain("b\nc");
    expect(w.session.status).toBe("waiting");
    w.session.answer(card.id, { kind: "choice", choiceId: "allow-once" });
    await w.idle();
    expect(saidBack(w.events)).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await w.session.close();
  });

  test("auto: the same edit is allowed by policy with no card", async () => {
    const fake = fakeAgent(async (p, client) => {
      const r = await client.request(acp.methods.client.session.requestPermission, editRequest(p, join(wt, "a.ts")));
      await client.notify(acp.methods.client.session.update, {
        sessionId: p.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(r) } },
      });
      return { stopReason: "end_turn" };
    });
    const w = world(fake, claudeSpec, 60_000, undefined, { mode: () => "auto" });
    w.session.send("edit");
    await w.idle();
    expect(w.types()).not.toContain("agent-permission");
    expect(saidBack(w.events)).toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await w.session.close();
  });

  test("plan: the agent's read-only mode is set before the prompt; approving the plan sets the worktree's mode", async () => {
    let mode: "auto" | "ask" | "plan" = "plan";
    const setModes: string[] = [];
    const fake = fakeAgent(
      async (p, client) => {
        if (fake.prompts.length > 1) return { stopReason: "end_turn" };
        await client.request(acp.methods.client.session.requestPermission, {
          sessionId: p.sessionId,
          toolCall: { toolCallId: "t9", title: "Approve Plan", kind: "switch_mode" },
          options: [
            { optionId: "auto", name: "Yes, and auto-accept edits", kind: "allow_once" },
            { optionId: "manual", name: "Yes, manually approve edits", kind: "allow_once" },
            { optionId: "cancel", name: "No, keep planning", kind: "reject_once" },
          ],
        });
        return { stopReason: "end_turn" };
      },
      { withModes: true, currentMode: "agent" },
    );
    // started in the agent's write mode, so plan needs a set_mode to read-only
    const w = world(fake, codexSpec, 60_000, undefined, {
      mode: () => mode,
      setMode: (m) => {
        setModes.push(m);
        mode = m;
      },
    });
    w.session.send("plan it");
    await waitFor(() => !!openAsk(w.events));
    expect(fake.modes).toEqual(["read-only"]);
    const card = w.events.at(-1) as Extract<AgentEvent, { type: "agent-permission" }>;
    w.session.answer(card.id, { kind: "choice", choiceId: "manual" });
    await w.idle();
    expect(setModes).toEqual(["ask"]);
    // the next turn runs in the write mode ask maps to
    w.session.send("build it");
    await w.idle();
    expect(fake.modes).toEqual(["read-only", "agent"]);
    await w.session.close();
  });

  test("a mode the agent changed on its own is remembered, so the next turn corrects it", async () => {
    const fake = fakeAgent(
      async (p, client) => {
        if (fake.prompts.length === 1) {
          await client.notify(acp.methods.client.session.update, {
            sessionId: p.sessionId,
            update: { sessionUpdate: "current_mode_update", currentModeId: "read-only" },
          });
        }
        return { stopReason: "end_turn" };
      },
      { withModes: true, currentMode: "agent" },
    );
    const w = world(fake, codexSpec, 60_000, undefined, {
      mode: () => "auto",
    });
    w.session.send("one");
    await w.idle();
    // already in agent mode: nothing to set
    expect(fake.modes).toEqual([]);
    w.session.send("two");
    await w.idle();
    expect(fake.modes).toEqual(["agent"]);
    await w.session.close();
  });

  test("an agent that offers its modes as a config option is switched through set_config_option", async () => {
    let mode: "auto" | "ask" | "plan" = "plan";
    const fake = fakeAgent(say("ok"), { modeOption: "build" });
    const spec: AgentSpec = { ...codexSpec, id: "opencode", modes: { plan: "plan", build: "build" } };
    const w = world(fake, spec, 60_000, undefined, { mode: () => mode });
    w.session.send("plan it");
    await w.idle();
    expect(fake.configs).toEqual(["mode=plan"]);
    expect(fake.modes).toEqual([]);
    // already there: a second turn in plan sets nothing
    w.session.send("still planning");
    await w.idle();
    expect(fake.configs).toEqual(["mode=plan"]);
    mode = "auto";
    w.session.send("build it");
    await w.idle();
    expect(fake.configs).toEqual(["mode=plan", "mode=build"]);
    await w.session.close();
  });
});

// The model and the effort: the agent's advertised choices reach the picker, and a worktree that
// asks for one gets it set before the prompt, once, with the agent's answer kept as the truth.
describe("AcpSession options", () => {
  const infos = (events: AgentEvent[]) =>
    events.filter((e) => e.type === "session-info").map(({ type: _t, sessionId: _s, ...rest }) => rest);

  test("the choices are learned when the session opens, and the record's model is applied before the prompt", async () => {
    let learned: Array<{ id: string; name: string }> = [];
    let model: string | undefined = "big-model";
    const fake = fakeAgent(say("ok"));
    const w = world(fake, claudeSpec, 60_000, undefined, {
      option: (c) => (c === "model" ? model : undefined),
      onOptionsLearned: (c, m) => {
        if (c === "model") learned = m;
      },
    });
    w.session.send("one");
    await w.idle();
    expect(learned.map((m) => m.id)).toEqual(["test-model", "big-model"]);
    expect(fake.configs).toEqual(["model=big-model"]);
    // the switch is visible in the transcript, and not asked for again while it holds
    expect(infos(w.events)).toEqual([{ model: "test-model" }, { model: "big-model" }]);
    w.session.send("two");
    await w.idle();
    expect(fake.configs).toEqual(["model=big-model"]);
    // back to the default: nothing is sent, the agent keeps what it has until a model is named
    model = undefined;
    w.session.send("three");
    await w.idle();
    expect(fake.configs).toEqual(["model=big-model"]);
    // a model the agent does not offer is ignored rather than sent
    model = "nope";
    w.session.send("four");
    await w.idle();
    expect(fake.configs).toEqual(["model=big-model"]);
    await w.session.close();
  });

  test("a side question on the agent's quick model sets it before the read-only mode", async () => {
    const fake = fakeAgent(say("sticky-header"), { withModes: true, currentMode: "agent" });
    const w = world(fake, { ...claudeSpec, quickModel: "big-model" });
    expect(await w.session.ask("sys", "name this", { quick: "prefer" })).toBe("sticky-header");
    expect(fake.calls).toEqual(["config model=big-model", "mode read-only"]);
    await w.session.close();
  });

  test("with the quick model gone, prefer asks on the default and require asks nothing", async () => {
    const fake = fakeAgent(say("ok"), { caps: { close: true } });
    const w = world(fake, { ...claudeSpec, quickModel: "retired-model" });
    expect(await w.session.ask("sys", "name this", { quick: "prefer" })).toBe("ok");
    expect(await w.session.ask("sys", "recap this", { quick: "require" })).toBeNull();
    // the second session opened and was cleaned up, but never saw a prompt or a model switch
    expect(fake.prompts).toHaveLength(1);
    for (let i = 0; i < 100 && fake.calls.length < 2; i++) await Bun.sleep(5);
    expect(fake.calls).toEqual(["close s1", "close s2"]);
    await w.session.close();
  });

  // Claude's id is `effort`, Codex's is `reasoning_effort`: the category is what toyon reads
  for (const id of ["effort", "reasoning_effort"]) {
    test(`effort (${id}) is applied after the model, from the list the model switch came back with`, async () => {
      const learned = new Map<string, string[]>();
      const fake = fakeAgent(say("ok"), { effort: { id, for: ["big-model"] } });
      const w = world(fake, claudeSpec, 60_000, undefined, {
        option: (c) => (c === "model" ? "big-model" : "high"),
        onOptionsLearned: (c, m) =>
          learned.set(
            c,
            m.map((x) => x.id),
          ),
      });
      w.session.send("one");
      await w.idle();
      // the session opened on test-model, which has no effort: the switch brought the option in
      expect(fake.configs).toEqual(["model=big-model", `${id}=high`]);
      expect(infos(w.events)).toEqual([
        { model: "test-model" },
        { model: "big-model", effort: "default" },
        { model: "big-model", effort: "high" },
      ]);
      expect(learned.get("thought_level")).toEqual(["default", "high"]);
      w.session.send("two");
      await w.idle();
      expect(fake.configs).toEqual(["model=big-model", `${id}=high`]);
      await w.session.close();
    });
  }

  test("an effort the current model has not got is left alone, and the agent's own change is absorbed", async () => {
    let effort: string | undefined = "high";
    const fake: FakeAgent = fakeAgent(
      async (p, client) => {
        // the agent switches its own effort mid-turn (a slash command would)
        fake.effort = "default";
        await client.notify(acp.methods.client.session.update, {
          sessionId: p.sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: fake.options() },
        });
        return { stopReason: "end_turn" };
      },
      { effort: { for: ["test-model"] } },
    );
    const w = world(fake, claudeSpec, 60_000, undefined, {
      option: (c) => (c === "thought_level" ? effort : undefined),
    });
    w.session.send("one");
    await w.idle();
    expect(fake.configs).toEqual(["effort=high"]);
    // the update is the truth now: the next turn asks for high again, since the record still says so
    expect(infos(w.events).at(-1)).toEqual({ model: "test-model", effort: "default" });
    w.session.send("two");
    await w.idle();
    expect(fake.configs).toEqual(["effort=high", "effort=high"]);
    // a level the list lacks is not sent
    effort = "max";
    fake.effort = "default";
    w.session.send("three");
    await w.idle();
    expect(fake.configs).toEqual(["effort=high", "effort=high"]);
    await w.session.close();
  });
});
