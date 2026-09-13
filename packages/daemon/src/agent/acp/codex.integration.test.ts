import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@toyon/shared";
import { sh, tmpRepo } from "../../../test/helpers/tmp-repo.ts";
import { makePaths } from "../../core/paths.ts";
import { GIT } from "../../git/exec.ts";
import { AttachmentStore } from "../attachments.ts";
import { AgentRegistry, BUILTIN_AGENTS } from "../registry.ts";
import { prepareLaunch } from "../sandbox.ts";
import { AcpSession } from "./session.ts";
import { supportsSteering } from "./steering.ts";
import { spawnAcp } from "./transport.ts";

// The real codex-acp, for the one thing the Claude integration cannot tell us: that steering is an
// extension both builtins speak, not a Claude arrangement. Opt-in, it spawns the machine's adapter:
// TOYON_TEST_CODEX=1 bun test codex.integration
//
// The handshake test needs no credentials. The turn below does: a Codex login, not just the file at
// ~/.codex/auth.json, which happily holds a placeholder key that only fails at the first request.

const enabled = process.env.TOYON_TEST_CODEX === "1";

function registry() {
  return new AgentRegistry(BUILTIN_AGENTS, makePaths().agentsDir);
}

function world() {
  const t = tmpRepo();
  const wt = join(t.repo, "..", "wt");
  sh(t.repo, GIT, "worktree", "add", "-q", "-b", "feat", wt, "main");
  const reg = registry();
  const events: AgentEvent[] = [];
  let sessionId: string | undefined;
  const session = new AcpSession({
    worktreeId: "it",
    cwd: wt,
    spec: () => reg.require("codex"),
    connect: (app, spec, prepared) => spawnAcp(app, reg.launch(spec, prepared), wt, "it"),
    launch: (spec) => reg.command(spec),
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
  return { t, wt, events, session, settle };
}

describe.skipIf(!enabled)("codex via ACP (integration)", () => {
  test("the adapter installs on demand", async () => {
    await registry().install("codex");
  }, 300_000);

  test("the adapter advertises steering, which is what turns the queue off", async () => {
    const t = tmpRepo();
    const reg = registry();
    const spec = reg.require("codex");
    const link = spawnAcp(
      acp.client({ name: "toyon" }),
      reg.launch(spec, await prepareLaunch(t.repo, spec)),
      t.repo,
      "it",
    );
    try {
      const init = await link.conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, elicitation: { form: {} } },
        clientInfo: { name: "toyon", version: "0" },
      });
      expect(supportsSteering(init)).toBe(true);
    } finally {
      await link.kill();
      t.cleanup();
    }
  }, 120_000);

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
      expect(session.queueLength).toBe(0);
      expect(events.filter((e) => e.type === "turn-start")).toHaveLength(1);
      expect(events.filter((e) => e.type === "turn-end")).toHaveLength(1);
      expect(events.filter((e) => e.type === "user-message")).toHaveLength(2);
    } finally {
      await session.close();
      t.cleanup();
    }
  }, 300_000);
});
