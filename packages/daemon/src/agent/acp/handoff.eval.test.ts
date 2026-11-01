import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, PermissionMode } from "@toyon/shared";
import { sh, tmpRepo } from "../../../test/helpers/tmp-repo.ts";
import { makePaths } from "../../core/paths.ts";
import { GIT } from "../../git/exec.ts";
import { HELD, handoffTool, parsePieces, type RawPiece } from "../../worktrees/handoff.ts";
import { overNameShape } from "../../worktrees/naming.ts";
import { AttachmentStore } from "../attachments.ts";
import { ToolSet, ToyonMcp } from "../mcp.ts";
import { SYSTEM_APPEND } from "../prompt.ts";
import { AgentRegistry, BUILTIN_AGENTS } from "../registry.ts";
import { UploadStore } from "../uploads.ts";
import { AcpSession } from "./session.ts";
import { spawnAcp } from "./transport.ts";

// How the real Claude adapter uses the handoff tool under SYSTEM_APPEND, measured rather than
// assumed: a wording change to the handoff sentences has no eval otherwise. Each case is a plan
// request on a throwaway repo; the agent runs in plan mode with Toyon's MCP server serving the
// real handoff tool (its schema and shape check, handoff.ts), and the run ends at the plan card.
// Four reads per run: did it call the tool, before the card, with pieces the daemon accepts, and
// did a piece go to a sibling (or, for one-piece work, was the tool left alone). Rates per arm are printed at the
// end and written as JSON when TOYON_EVAL_OUT names a file; nothing is asserted about them, since
// a run is a sample and the report is the point. Opt-in: it spends tokens on every run; a run
// takes ten to thirty seconds, so the default three runs over four cases is a few minutes an arm.
//
//   TOYON_TEST_HANDOFF_EVAL=1 bun test handoff.eval
//   TOYON_EVAL_APPEND=/path/to/candidate.txt   a second arm, the whole SYSTEM_APPEND as it would read
//   TOYON_EVAL_RUNS=3                           runs per case and arm (the default)
//   TOYON_EVAL_OUT=/path/to/report.json         where the rows go

const keychain = () =>
  process.platform === "darwin" &&
  spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { stdio: "ignore" }).status === 0;
const creds =
  !!process.env.ANTHROPIC_API_KEY ||
  !!process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  existsSync(join(homedir(), ".claude", ".credentials.json")) ||
  keychain();
const enabled = process.env.TOYON_TEST_HANDOFF_EVAL === "1" && creds;

const RUNS = Number(process.env.TOYON_EVAL_RUNS) || 3;
/** one plan turn's ceiling; a case's test waits for all its runs */
const RUN_MS = 240_000;

// the adapter's own install beside the machine's, shared with the integration test
const agentsDir = join(makePaths().agentsDir, "..", "agents-test");

interface Arm {
  name: string;
  append: string;
}

const arms: Arm[] = [{ name: "current", append: SYSTEM_APPEND }];
if (process.env.TOYON_EVAL_APPEND) {
  arms.push({ name: "candidate", append: readFileSync(process.env.TOYON_EVAL_APPEND, "utf8").trim() });
}

interface Case {
  id: string;
  prompt: string;
  /** `split`: the work holds a piece a sibling could take in parallel, and the tool should carry it;
   * `one`: a single piece of work, where a call would be the tool over-firing */
  want: "split" | "one";
}

/** Plan requests that read like a person's: none names the tool or says "split", since the rules
 * under test are what should make the agent reach for it. */
const CASES: Case[] = [
  {
    id: "docs and ci",
    want: "split",
    prompt:
      "Plan two things for this repo, then ask me to approve the plan: a CONTRIBUTING.md that explains how to clone the repo and run its tests, and a GitHub Actions workflow at .github/workflows/test.yml that runs `bun test` on every push. Keep the plan short.",
  },
  {
    id: "two jobs",
    want: "split",
    prompt:
      "Plan the following, then ask me to approve. First, a command-line tool at src/cli.ts in TypeScript that takes a path and prints a word count for each file under it, with a test file beside it. Second, a docs/ folder with a getting-started page and a page per command, written in markdown with a table of contents. The two do not depend on each other.",
  },
  {
    id: "aside named",
    want: "split",
    prompt:
      "Plan how to change the heading in README.md to say Hello, then ask me to approve. One more thing, which is a different job and should not hold this up: a Makefile with test and lint targets would be good to have at some point.",
  },
  {
    id: "one file",
    want: "one",
    prompt:
      "Plan how to change README.md so it contains the single word hello, then ask me to approve. Keep the plan to two short lines.",
  },
];

interface Outcome {
  arm: string;
  case: string;
  want: Case["want"];
  /** the tool was called at least once */
  called: boolean;
  /** every call parsed, every title held the namer's shape and every plan had words */
  valid: boolean;
  /** the first call came before the plan card; null without both */
  beforeCard: boolean | null;
  /** the last accepted list, by where its pieces go */
  pieces: { here: number; worktree: number; send: number };
  /** a plan card went up */
  card: boolean;
  /** the turn met an agent error */
  error: boolean;
  /** what the case wanted happened */
  pass: boolean;
  ms: number;
}

const results: Outcome[] = [];

async function run(arm: Arm, c: Case): Promise<Outcome> {
  const started = Date.now();
  const t = tmpRepo();
  const wt = join(t.repo, "..", "wt");
  sh(t.repo, GIT, "worktree", "add", "-q", "-b", "feat", wt, "main");
  const registry = new AgentRegistry(BUILTIN_AGENTS, agentsDir);
  const events: AgentEvent[] = [];
  const calls: { at: number; pieces: RawPiece[] | null }[] = [];
  const tools = new ToolSet();
  tools.add({
    tool: () => handoffTool([], []),
    call: (_wt, args) => {
      const parsed = parsePieces(args);
      if ("refused" in parsed) {
        calls.push({ at: events.length, pieces: null });
        return { text: parsed.refused, isError: true };
      }
      calls.push({ at: events.length, pieces: parsed.pieces });
      return { text: HELD };
    },
  });
  let port = 0;
  const toyon = new ToyonMcp({ url: () => `http://127.0.0.1:${port}/mcp/ev`, version: "0.0.0", tools });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => toyon.fetch(req, "ev") });
  port = server.port ?? 0;
  const record: { mode: PermissionMode } = { mode: "plan" };
  let sessionId: string | undefined;
  const uploads = new UploadStore(t.paths.uploadsDir);
  const session = new AcpSession({
    worktreeId: "ev",
    cwd: wt,
    spec: () => registry.require("claude"),
    connect: (app, spec, prepared) => spawnAcp(app, registry.launch(spec, prepared), wt, "ev"),
    launch: (spec) => registry.command(spec),
    transcriptsDir: t.paths.transcriptsDir,
    attachments: new AttachmentStore(t.paths.attachmentsDir, uploads),
    getSessionId: () => sessionId,
    setSessionId: (id) => {
      sessionId = id;
    },
    onEvent: (e) => events.push(e),
    onStatus: () => {},
    idleMs: 60_000,
    mode: () => record.mode,
    setMode: (m) => {
      record.mode = m;
    },
    mcp: { open: () => toyon.open("ev"), close: () => toyon.close("ev") },
    systemAppend: () => arm.append,
  });
  const busy = () => session.status === "working" || session.queueLength > 0;
  try {
    session.send(c.prompt);
    // the run ends at the plan card: what the tool was given by then is the measurement
    for (let i = 0; i < RUN_MS / 100 && busy() && !events.some((e) => e.type === "agent-permission"); i++) {
      await Bun.sleep(100);
    }
    if (busy()) session.stop();
    for (let i = 0; i < 600 && busy(); i++) await Bun.sleep(100);
  } finally {
    await session.close();
    server.stop(true);
    t.cleanup();
  }
  const cardAt = events.findIndex((e) => e.type === "agent-permission");
  const accepted = calls.filter((k) => k.pieces).map((k) => k.pieces!);
  const last = accepted.at(-1) ?? [];
  const pieces = { here: 0, worktree: 0, send: 0 };
  for (const p of last) pieces[p.where]++;
  const valid =
    calls.length > 0 &&
    calls.every((k) => k.pieces !== null) &&
    last.every((p) => !overNameShape(p.title.trim()) && p.plan.trim().length > 0);
  const called = calls.length > 0;
  const beforeCard = called && cardAt >= 0 ? calls[0]!.at <= cardAt : null;
  // the agent's own work need not be a piece, so one piece for a sibling beside work it keeps is
  // a split as much as a list naming both
  const split = pieces.worktree + pieces.send >= 1;
  const pass = c.want === "split" ? called && valid && beforeCard === true && split : !called;
  return {
    arm: arm.name,
    case: c.id,
    want: c.want,
    called,
    valid,
    beforeCard,
    pieces,
    card: cardAt >= 0,
    error: events.some((e) => e.type === "agent-error"),
    pass,
    ms: Date.now() - started,
  };
}

const pct = (rows: Outcome[], f: (o: Outcome) => boolean) =>
  rows.length ? `${Math.round((100 * rows.filter(f).length) / rows.length)}%` : "-";

/** one line per arm and case, then one per arm: rates over the runs */
function report(): string {
  const lines: string[] = [];
  lines.push("arm        case          n  pass  called  valid  before card  split");
  for (const arm of arms) {
    for (const c of CASES) {
      const rows = results.filter((r) => r.arm === arm.name && r.case === c.id);
      lines.push(
        [
          arm.name.padEnd(10),
          c.id.padEnd(13),
          String(rows.length).padStart(2),
          pct(rows, (r) => r.pass).padStart(5),
          pct(rows, (r) => r.called).padStart(7),
          pct(rows, (r) => r.valid).padStart(6),
          pct(rows, (r) => r.beforeCard === true).padStart(12),
          pct(rows, (r) => r.pieces.worktree + r.pieces.send >= 1).padStart(6),
        ].join(" "),
      );
    }
    const all = results.filter((r) => r.arm === arm.name);
    lines.push(
      `${arm.name.padEnd(10)} ${"all".padEnd(13)} ${String(all.length).padStart(2)} ${pct(all, (r) => r.pass).padStart(5)}`,
    );
  }
  const errors = results.filter((r) => r.error);
  if (errors.length) lines.push(`${errors.length} run(s) met an agent error; their rows count as they fell`);
  return lines.join("\n");
}

describe.skipIf(!enabled)("handoff eval (real agent)", () => {
  test("the adapter installs on demand", async () => {
    await new AgentRegistry(BUILTIN_AGENTS, agentsDir).install("claude");
  }, 300_000);

  for (const arm of arms) {
    for (const c of CASES) {
      test(
        `${arm.name}: ${c.id}`,
        async () => {
          for (let i = 0; i < RUNS; i++) results.push(await run(arm, c));
          // the rows are the result; a run that never reached the agent is the one failure here
          expect(results.filter((r) => r.arm === arm.name && r.case === c.id)).toHaveLength(RUNS);
        },
        RUNS * (RUN_MS + 90_000),
      );
    }
  }

  afterAll(() => {
    if (results.length === 0) return;
    const text = report();
    console.log(`\n${text}\n`);
    if (process.env.TOYON_EVAL_OUT) {
      writeFileSync(
        process.env.TOYON_EVAL_OUT,
        `${JSON.stringify({ arms: arms.map((a) => a.name), results }, null, 2)}\n`,
      );
    }
  });
});
