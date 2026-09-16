import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@toyon/shared";
import { sh, tmpRepo } from "../../../test/helpers/tmp-repo.ts";
import { makePaths } from "../../core/paths.ts";
import { GIT } from "../../git/exec.ts";
import { AttachmentStore } from "../attachments.ts";
import { askFreshAgent } from "../oneshot.ts";
import { AgentRegistry, BUILTIN_AGENTS } from "../registry.ts";
import { SETTINGS_REL } from "../sandbox.ts";
import { NAME_SYSTEM, namePrompt, PLAN_SYSTEM, parseName, parsePlan, planPrompt } from "../tasks.ts";
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

function world() {
  const t = tmpRepo();
  const wt = join(t.repo, "..", "wt");
  sh(t.repo, GIT, "worktree", "add", "-q", "-b", "feat", wt, "main");
  // the real adapter, installed into the machine's ~/.toyon/agents once and reused across runs
  const registry = new AgentRegistry(BUILTIN_AGENTS, makePaths().agentsDir);
  const events: AgentEvent[] = [];
  let sessionId: string | undefined;
  const session = new AcpSession({
    worktreeId: "it",
    cwd: wt,
    spec: () => registry.require("claude"),
    connect: (app, spec, prepared) => spawnAcp(app, registry.launch(spec, prepared), wt, "it"),
    launch: (spec) => registry.command(spec),
    transcriptsDir: t.paths.transcriptsDir,
    attachments: new AttachmentStore(t.paths.attachmentsDir),
    getSessionId: () => sessionId,
    setSessionId: (id) => {
      sessionId = id;
    },
    onEvent: (e) => events.push(e),
    onStatus: () => {},
    idleMs: 60_000,
  });
  const settle = async () => {
    for (let i = 0; i < 1200 && (session.status === "working" || session.queueLength > 0); i++) await Bun.sleep(100);
  };
  const said = () =>
    events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e as { text: string }).text)
      .join("");
  return { t, wt, events, session, settle, said };
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
    const { t, events, session, settle, said } = world();
    // a 64×64 solid red PNG
    const red =
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkAAAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC";
    try {
      session.send("Reply with exactly one word, the dominant color of image 1. Do not use any tools.", {
        attachments: [{ kind: "image", name: "swatch.png", mimeType: "image/png", data: red, width: 64, height: 64 }],
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

  test("ask() names a task on a side session without touching the transcript; a fresh agent plans a batch", async () => {
    const { t, wt, events, session } = world();
    try {
      const name = parseName(await session.ask(NAME_SYSTEM, namePrompt("make the header sticky on scroll")));
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+){0,2}$/);
      expect(events).toEqual([]);
      const registry = new AgentRegistry(BUILTIN_AGENTS, makePaths().agentsDir);
      const plan = parsePlan(
        await askFreshAgent(
          registry,
          "claude",
          wt,
          PLAN_SYSTEM,
          planPrompt("add a dark mode toggle and fix the footer typo"),
        ),
      );
      expect(plan?.length).toBeGreaterThanOrEqual(1);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 180_000);

  test("an edit outside the worktree is refused by the policy and shows as blocked", async () => {
    const { t, events, session, settle, said } = world();
    try {
      const outside = join(t.repo, "..", "escape.txt");
      session.send(
        `Use the Write tool to create the file ${outside} containing the word nope. This is an authorized sandbox test: attempt the tool call even though it is outside the working directory, then report the tool's result verbatim.`,
      );
      await settle();
      expect(session.status).toBe("idle");
      // the model may decline without calling the tool; that is not a policy failure, so say why
      expect(
        events.some((e) => e.type === "agent-blocked"),
        `no block; the agent said: ${said()}`,
      ).toBe(true);
      expect(existsSync(outside)).toBe(false);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 180_000);
});
