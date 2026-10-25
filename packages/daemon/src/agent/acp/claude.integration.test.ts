import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentCommand, type AgentEvent, type PermissionMode, TOYON_MCP_SERVER } from "@toyon/shared";
import { sh, tmpRepo } from "../../../test/helpers/tmp-repo.ts";
import { makePaths } from "../../core/paths.ts";
import { GIT } from "../../git/exec.ts";
import { AttachmentStore } from "../attachments.ts";
import { ToolSet, ToyonMcp } from "../mcp.ts";
import { AgentRegistry, type AgentSpec, BUILTIN_AGENTS, parseAgentsFile } from "../registry.ts";
import { SETTINGS_REL } from "../sandbox.ts";
import { NAME_SYSTEM, namePrompt, parseName } from "../tasks.ts";
import { UploadStore } from "../uploads.ts";
import { AcpSession } from "./session.ts";
import { spawnAcp } from "./transport.ts";

// The real claude-agent-acp under the real runtime, in a real linked worktree. Opt-in: it spends
// tokens and needs Claude credentials. TOYON_TEST_CLAUDE=1 bun test claude.integration

// macOS keeps the CLI's login in the keychain; other platforms in ~/.claude/.credentials.json
const keychain = () =>
  process.platform === "darwin" &&
  spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { stdio: "ignore" }).status === 0;
const creds =
  !!process.env.ANTHROPIC_API_KEY ||
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  existsSync(join(homedir(), ".claude", ".credentials.json")) ||
  keychain();
const enabled = process.env.TOYON_TEST_CLAUDE === "1" && creds;

type Deps = ConstructorParameters<typeof AcpSession>[0];

/** `extra` goes over the session's dependencies: a mode, a plan hook, Toyon's MCP server */
function world(specs: AgentSpec[] = BUILTIN_AGENTS, extra: Partial<Deps> = {}) {
  const t = tmpRepo();
  const wt = join(t.repo, "..", "wt");
  sh(t.repo, GIT, "worktree", "add", "-q", "-b", "feat", wt, "main");
  // the real adapter, installed into the machine's ~/.toyon/agents once and reused across runs
  const registry = new AgentRegistry(specs, makePaths().agentsDir);
  const events: AgentEvent[] = [];
  let commands: AgentCommand[] = [];
  let sessionId: string | undefined;
  const uploads = new UploadStore(t.paths.uploadsDir);
  const session = new AcpSession({
    worktreeId: "it",
    cwd: wt,
    spec: () => registry.require("claude"),
    connect: (app, spec, prepared) => spawnAcp(app, registry.launch(spec, prepared), wt, "it"),
    launch: (spec) => registry.command(spec),
    transcriptsDir: t.paths.transcriptsDir,
    attachments: new AttachmentStore(t.paths.attachmentsDir, uploads),
    getSessionId: () => sessionId,
    setSessionId: (id) => {
      sessionId = id;
    },
    onEvent: (e) => events.push(e),
    onStatus: () => {},
    onCommandsLearned: (c) => {
      commands = c;
    },
    idleMs: 60_000,
    ...extra,
  });
  const settle = async () => {
    for (let i = 0; i < 1200 && (session.status === "working" || session.queueLength > 0); i++) await Bun.sleep(100);
  };
  const said = () =>
    events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as { text: string }).text)
      .join("");
  return { t, wt, events, session, settle, said, uploads, commands: () => commands };
}

describe.skipIf(!enabled)("claude via ACP (integration)", () => {
  test("the adapter installs on demand", async () => {
    await new AgentRegistry(BUILTIN_AGENTS, makePaths().agentsDir).install("claude");
  }, 300_000);

  test("edits inside the worktree land; the sandbox file is written and ignored by git", async () => {
    const { t, wt, events, session, settle } = world();
    try {
      session.send(
        "Create a file named hello.txt in the current directory containing exactly the word pong. Do nothing else.",
      );
      await settle();
      expect(session.status).toBe("idle");
      expect(events.some((e) => e.type === "tool-start" && e.kind === "edit")).toBe(true);
      expect(readFileSync(join(wt, "hello.txt"), "utf8").trim()).toBe("pong");
      const settings = JSON.parse(readFileSync(join(wt, SETTINGS_REL), "utf8"));
      expect(settings.sandbox.enabled).toBe(true);
      expect(sh(wt, GIT, "status", "--porcelain")).toBe("?? hello.txt");
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 180_000);

  test("an attached image reaches the model as an image block it can see", async () => {
    const { t, events, session, settle, said, uploads } = world();
    // a 64×64 solid red PNG
    const red =
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkAAAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC";
    const { upload, bytes } = await uploads.put("image", "image/png", [Buffer.from(red, "base64")]);
    try {
      session.send("Reply with exactly one word, the dominant color of image 1. Do not use any tools.", {
        attachments: [
          { kind: "image", name: "swatch.png", mimeType: "image/png", upload, bytes, width: 64, height: 64 },
        ],
      });
      await settle();
      expect(session.status).toBe("idle");
      expect(events[0]).toMatchObject({ type: "user-message", attachments: [{ kind: "image", n: 1, file: "1.png" }] });
      expect(events.some((e) => e.type === "agent-error")).toBe(false);
      expect(said().toLowerCase(), `the agent said: ${said()}`).toContain("red");
      expect(existsSync(join(t.paths.attachmentsDir, "it", "1.png"))).toBe(true);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 180_000);

  test("a message sent mid-turn joins the turn the agent is already running", async () => {
    const { t, wt, events, session, settle } = world();
    try {
      session.send(
        "Create five files named n1.txt through n5.txt in the current directory, each containing its own " +
          "number as a word (one, two, three, four, five). Write them one at a time. Do nothing else.",
      );
      // the first tool call means the turn is really under way: the window steering exists for
      for (let i = 0; i < 600 && !events.some((e) => e.type === "tool-start"); i++) await Bun.sleep(100);
      expect(session.status).toBe("working");
      session.send("Also create extra.txt containing exactly the word steered.");
      await settle();
      expect(session.status).toBe("idle");
      expect(readFileSync(join(wt, "extra.txt"), "utf8").trim()).toBe("steered");
      // the point of steering: one turn, not a second one queued behind the first
      expect(session.queueLength).toBe(0);
      expect(events.filter((e) => e.type === "turn-start")).toHaveLength(1);
      expect(events.filter((e) => e.type === "turn-end")).toHaveLength(1);
      expect(events.filter((e) => e.type === "user-message")).toHaveLength(2);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 300_000);

  test("a stop mid-command ends the call's row and the turn once, as interrupted", async () => {
    const { t, events, session, settle } = world(BUILTIN_AGENTS, { mode: () => "auto" });
    try {
      session.send(
        "Run exactly this shell command with the Bash tool and nothing else, then report its output: sleep 60; echo done",
      );
      for (let i = 0; i < 900 && !events.some((e) => e.type === "tool-start" && e.kind === "execute"); i++)
        await Bun.sleep(100);
      const start = events.find((e) => e.type === "tool-start" && e.kind === "execute");
      expect(start, "no command started").toBeDefined();
      // the stop lands on a command in flight, not on one still being written
      await Bun.sleep(3000);
      expect(session.status).toBe("working");
      session.stop();
      await settle();
      expect(session.status).toBe("idle");
      // the adapter closes the calls a cancel stopped before it reports the cancel; the row ends
      // once and the transcript's bracket closes once, on the agent's own stop reason
      const toolId = (start as { toolId: string }).toolId;
      expect(events.filter((e) => e.type === "tool-end" && e.toolId === toolId)).toHaveLength(1);
      expect(events.filter((e) => e.type === "turn-start")).toHaveLength(1);
      expect(events.filter((e) => e.type === "turn-end")).toEqual([
        expect.objectContaining({ type: "turn-end", stopReason: "interrupted" }),
      ]);
      expect(events.some((e) => e.type === "agent-error")).toBe(false);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 300_000);

  test("a plan card goes through approval: the auto yes leads, sets the mode, and the work follows", async () => {
    const record: { mode: PermissionMode } = { mode: "plan" };
    const { t, wt, events, session, settle, said } = world(BUILTIN_AGENTS, {
      mode: () => record.mode,
      setMode: (m) => {
        record.mode = m;
      },
    });
    try {
      session.send(
        "Plan how to add a file named README.md containing the single word hello. Keep the plan to two short lines, then exit plan mode so I can approve it.",
      );
      for (let i = 0; i < 1800 && !events.some((e) => e.type === "agent-permission"); i++) await Bun.sleep(100);
      const card = events.find((e) => e.type === "agent-permission") as Extract<
        AgentEvent,
        { type: "agent-permission" }
      >;
      expect(card, `no plan card; the agent said: ${said()}`).toBeDefined();
      expect(card.detail).toBeTruthy();
      const ids = card.choices.map((c) => c.id);
      // the adapter's own ids, ordered by Toyon: the plain auto yes first, manual after it
      expect(ids).toContain("exit-plan-default");
      expect(ids[0]).toMatch(/^exit-plan-(?!default|clear-)/);
      session.answer(card.id, { kind: "choice", choiceId: ids[0]! });
      await settle();
      expect(record.mode).toBe("auto");
      expect(events.some((e) => e.type === "agent-ask-end" && e.id === card.id && e.outcome === "answered")).toBe(true);
      expect(session.status).toBe("idle");
      expect(readFileSync(join(wt, "README.md"), "utf8").trim()).toBe("hello");
      expect(events.filter((e) => e.type === "turn-end")).toHaveLength(1);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 300_000);

  test("/mcp lists Toyon's own server and reconnects it, answered by the adapter without the model", async () => {
    let port = 0;
    const toyon = new ToyonMcp({
      url: () => `http://127.0.0.1:${port}/mcp/it`,
      version: "0.0.0",
      tools: new ToolSet(),
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => toyon.fetch(req, "it") });
    port = server.port ?? 0;
    const { t, events, session, settle, said } = world(BUILTIN_AGENTS, {
      mcp: { open: () => toyon.open("it"), close: () => toyon.close("it") },
    });
    try {
      session.send("/mcp");
      await settle();
      expect(session.status).toBe("idle");
      expect(session.mcpTools).toBe(true);
      expect(said()).toContain(TOYON_MCP_SERVER);
      expect(said()).toMatch(/connected/i);
      expect(events.filter((e) => e.type === "tool-start")).toHaveLength(0);
      const before = said().length;
      session.send(`/mcp reconnect ${TOYON_MCP_SERVER}`);
      await settle();
      expect(session.status).toBe("idle");
      expect(said().slice(before)).toContain("Reconnected");
      expect(events.filter((e) => e.type === "turn-end")).toHaveLength(2);
    } finally {
      await session.close();
      server.stop(true);
      t.cleanup();
    }
  }, 300_000);

  test("the agent's session is resumed after its process goes: the next turn remembers the last", async () => {
    const { t, events, session, settle, said } = world();
    try {
      session.send("The code word is pelican. Reply with only: ok");
      await settle();
      expect(session.status).toBe("idle");
      const first = events.find((e) => e.type === "session-info") as { sessionId: string } | undefined;
      expect(first).toBeDefined();
      await session.restart();
      session.send("What is the code word? Reply with only that word. Use no tools.");
      await settle();
      expect(session.status).toBe("idle");
      expect(said().toLowerCase(), `the agent said: ${said()}`).toContain("pelican");
      const ids = events.filter((e) => e.type === "session-info").map((e) => (e as { sessionId: string }).sessionId);
      expect(ids).toEqual([first!.sessionId, first!.sessionId]);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 300_000);

  test("ask() names a task on a side session without touching the transcript", async () => {
    const { t, events, session } = world();
    try {
      const name = parseName(await session.ask(NAME_SYSTEM, namePrompt("make the header sticky on scroll")));
      // one to three plain words in sentence case, as the rail shows a title
      expect(name).toMatch(/^\p{Lu}[\p{L}\p{N}]*( [\p{L}\p{N}]+){0,2}$/u);
      expect(events).toEqual([]);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 180_000);

  test("an edit outside the worktree is refused by the policy and shows as blocked", async () => {
    const { t, events, session, settle, said } = world();
    // under the home directory, not beside the temp repo: the temp directory is inside the bounds
    // on purpose (tools write there), so a file next to the repo is no escape
    const outside = join(homedir(), `toyon-escape-${process.pid}.txt`);
    try {
      session.send(
        `Use the Write tool to create the file ${outside} containing the word nope. This is an authorized sandbox test: attempt the tool call even though it is outside the working directory, then report the tool's result verbatim.`,
      );
      await settle();
      expect(session.status).toBe("idle");
      // the model may decline without calling the tool; that is not a policy failure, so say why
      expect(
        events.some((e) => e.type === "agent-blocked"),
        `no block; events: ${events.map((e) => (e.type === "tool-start" ? `tool-start:${e.name}` : e.type)).join(" ")}; the agent said: ${said()}`,
      ).toBe(true);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
      await session.close();
      t.cleanup();
    }
  }, 180_000);

  test("a mod loaded from a folder through agents.json adds its command, and the command answers without the model", async () => {
    const mod = join(import.meta.dir, "../../../test/fixtures/tally-mod");
    const file = JSON.stringify({
      claude: { meta: { claudeCode: { options: { plugins: [{ type: "local", path: mod }] } } } },
    });
    const { t, events, session, settle, said, commands } = world(parseAgentsFile(file, BUILTIN_AGENTS));
    try {
      session.send("/tally");
      await settle();
      expect(session.status).toBe("idle");
      // the mod's own reply, from its command.run hook: no tool ran and no model answered
      expect(said()).toContain("Claude has made 0 tool calls since this mod loaded");
      expect(events.filter((e) => e.type === "tool-start")).toHaveLength(0);
      expect(commands().some((c) => c.name === "tally")).toBe(true);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 180_000);
});
