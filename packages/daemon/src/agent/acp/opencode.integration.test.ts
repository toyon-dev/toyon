import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@toyon/shared";
import { sh, tmpRepo } from "../../../test/helpers/tmp-repo.ts";
import { makePaths } from "../../core/paths.ts";
import { GIT } from "../../git/exec.ts";
import { AttachmentStore } from "../attachments.ts";
import { AgentRegistry, BUILTIN_AGENTS } from "../registry.ts";
import { AcpSession } from "./session.ts";
import { spawnAcp } from "./transport.ts";

// The real OpenCode, installed on demand into the machine's ~/.toyon/agents, inside toyon's own
// sandbox. Opt-in: it downloads a ~150 MB binary and spends tokens on whatever provider OpenCode is
// logged into. TOYON_TEST_OPENCODE=1 bun test opencode.integration
// TOYON_TEST_OPENCODE_MODEL=github-copilot/gpt-5-mini picks the model; OpenCode's default otherwise.

const enabled = process.env.TOYON_TEST_OPENCODE === "1";
const model = process.env.TOYON_TEST_OPENCODE_MODEL;

function registry() {
  return new AgentRegistry(BUILTIN_AGENTS, makePaths().agentsDir);
}

describe.skipIf(!enabled)("opencode via ACP (integration)", () => {
  test("installs on demand", async () => {
    const reg = registry();
    await reg.install("opencode");
    expect(reg.unavailable(reg.get("opencode")!)).toBeNull();
  }, 600_000);

  test("an edit inside the worktree lands; a shell write outside it does not", async () => {
    const t = tmpRepo();
    const wt = join(t.repo, "..", "wt");
    sh(t.repo, GIT, "worktree", "add", "-q", "-b", "feat", wt, "main");
    // under the home directory, since the temp directory is inside the bounds
    const outside = join(homedir(), ".toyon-opencode-integration-outside");
    rmSync(outside, { force: true });
    const reg = registry();
    const events: AgentEvent[] = [];
    let sessionId: string | undefined;
    const session = new AcpSession({
      worktreeId: "it",
      cwd: wt,
      spec: () => reg.require("opencode"),
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
      mode: () => "auto",
      ...(model ? { option: (c: string) => (c === "model" ? model : undefined) } : {}),
    });
    try {
      session.send(
        `Create a file named a.txt containing the word hi using your file tool, then run the shell command: touch ${outside}. Do nothing else.`,
      );
      for (let i = 0; i < 3000 && (session.status === "working" || session.queueLength > 0); i++) await Bun.sleep(100);
      expect(readFileSync(join(wt, "a.txt"), "utf8").trim()).toBe("hi");
      expect(existsSync(outside)).toBe(false);
      expect(events.some((e) => e.type === "turn-end")).toBe(true);
    } finally {
      rmSync(outside, { force: true });
      await session.close();
      t.cleanup();
    }
  }, 600_000);
});
