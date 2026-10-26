import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { ArchivedWorktree, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { WORKTREES_TOOL } from "@toyon/shared";
import { tmpRepo } from "../../test/helpers/tmp-repo.ts";
import { transcriptPathFor } from "../agent/transcript.ts";
import { StateStore } from "../core/state.ts";
import { ARCHIVED_MAX, WorktreeLookup } from "./lookup.ts";

// The `worktrees` tool: the project's other rows as the mention would say them, found by title,
// branch or what the person wrote, so a question by ticket or topic reaches the right chat.

const repo: RepoInfo = {
  id: "r",
  path: "/nowhere",
  name: "x",
  defaultBranch: "main",
  config: { run: { web: "true" } },
  configFile: ".toyon/settings.json",
  needsSetup: false,
};
const row = (id: string, title: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  id,
  repoId: "r",
  path: `/nowhere/wt-${id}`,
  branch: `toyon/${id}`,
  kind: "worktree",
  proxyPort: 1,
  title,
  createdAt: 0,
  ...extra,
});
// Oct 19, 2026 at noon UTC: a day in any zone the test runs in
const day = (d: number) => Date.UTC(2026, 9, d, 12);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function make(worktrees: WorktreeInfo[], archived: ArchivedWorktree[] = []) {
  const t = tmpRepo();
  cleanups.push(t.cleanup);
  const state = new StateStore(t.paths, { repos: [repo], worktrees, sessions: {} });
  const lookup = new WorktreeLookup({ state, transcriptsDir: t.paths.transcriptsDir, archived: () => archived });
  /** a chat on disk: what the person wrote, with tool lines between that are never parsed */
  const chat = (file: string, said: { text: string; ts: number }[]) => {
    const lines = said.flatMap((s, i) => [
      JSON.stringify({ seq: i * 3, event: { type: "user-message", text: s.text, ts: s.ts } }),
      JSON.stringify({
        seq: i * 3 + 1,
        event: { type: "tool-start", toolId: "t", title: '"user-message" in a title' },
      }),
      JSON.stringify({ seq: i * 3 + 2, event: { type: "text-delta", text: "ok" } }),
    ]);
    writeFileSync(file, `${lines.join("\n")}\n`);
  };
  const path = (id: string) => transcriptPathFor(t.paths.transcriptsDir, id);
  return { lookup, chat, path, paths: t.paths };
}

const gone = (
  id: string,
  title: string,
  transcript: string,
  extra: Partial<ArchivedWorktree> = {},
): ArchivedWorktree => ({
  id,
  repoId: "r",
  title,
  branch: `toyon/${id}`,
  path: `/nowhere/wt-${id}`,
  createdAt: day(1),
  archivedAt: day(10),
  restorable: true,
  transcript,
  ...extra,
});

describe("the tool as listed", () => {
  test("is named for the shell to key on and counts what it can see right now", () => {
    const { lookup } = make([row("me", "Me"), row("a", "A"), row("b", "B")], [gone("z", "Z", "/none")]);
    const tool = lookup.tool("me");
    expect(tool.name).toBe(WORKTREES_TOOL);
    expect(tool.description).toContain("2 other worktrees are open and 1 is archived");
    expect(tool.inputSchema).toMatchObject({ type: "object", properties: { query: { type: "string" } } });
  });
});

describe("listing", () => {
  test("every other open row, by who wrote last, then the archive, each as the mention says it", async () => {
    const { lookup, chat, path } = make(
      [row("me", "Me"), row("old", "Old one"), row("fresh", "Fresh one")],
      [gone("z", "Landed thing", "/none", { landed: true })],
    );
    chat(path("old"), [{ text: "fix the thing", ts: day(2) }]);
    chat(path("fresh"), [{ text: "start the other thing", ts: day(5) }]);
    const r = await lookup.call("me", {});
    expect(r.isError).toBeUndefined();
    expect(r.text).toStartWith("2 other worktrees of this project are open and 1 is archived.");
    const at = (s: string) => r.text.indexOf(s);
    expect(at("@toyon/fresh")).toBeGreaterThan(0);
    expect(at("@toyon/fresh")).toBeLessThan(at("@toyon/old"));
    expect(at("@toyon/old")).toBeLessThan(at("@toyon/z"));
    expect(r.text).not.toContain("@toyon/me");
    expect(r.text).toContain(
      `@toyon/fresh is the worktree "Fresh one" in this project, checked out at /nowhere/wt-fresh.`,
    );
    expect(r.text).toContain(`Its chat is at ${path("fresh")}, one JSON object per line`);
    expect(r.text).toContain('The person first asked: "start the other thing" They last wrote there on Oct 5, 2026.');
    expect(r.text).toContain(
      '@toyon/z was the worktree "Landed thing" in this project, archived on Oct 10, 2026 after landing on main',
    );
  });

  test("a row with no chat yet is listed from its record alone", async () => {
    const { lookup } = make([row("me", "Me"), row("new", "New one", { createdAt: day(3) })]);
    const r = await lookup.call("me", {});
    expect(r.text).toContain('@toyon/new is the worktree "New one"');
    expect(r.text).not.toContain("first asked");
    expect(r.text).not.toContain("last wrote");
  });

  test("an archived chat that is gone falls back to the record's first prompt", async () => {
    const { lookup } = make([row("me", "Me")], [gone("z", "Z", "/none/z.jsonl", { prompt: "do the z thing" })]);
    const r = await lookup.call("me", {});
    expect(r.text).toContain('The person first asked: "do the z thing"');
  });

  test("the archive past the cap is counted, not listed, and a query reaches it", async () => {
    const many = Array.from({ length: ARCHIVED_MAX + 3 }, (_, i) => gone(`g${i}`, `Gone ${i}`, "/none"));
    const { lookup } = make([row("me", "Me")], many);
    const r = await lookup.call("me", {});
    expect(r.text).toContain(`@toyon/g${ARCHIVED_MAX - 1} `);
    expect(r.text).not.toContain(`@toyon/g${ARCHIVED_MAX} `);
    expect(r.text).toContain("3 older archived worktrees are not listed; pass a query to search them.");
    const q = await lookup.call("me", { query: `gone ${ARCHIVED_MAX + 1}` });
    expect(q.text).toContain(`@toyon/g${ARCHIVED_MAX + 1} `);
  });
});

describe("a query", () => {
  test("finds a chat by what the person wrote, when neither title nor branch say it", async () => {
    const { lookup, chat, path } = make([
      row("me", "Me"),
      row("double-log", "Double log"),
      row("ask-metrics", "Ask metrics"),
    ]);
    chat(path("double-log"), [
      { text: "https://x/browse/COS-634: send Ask events to Databricks through the PAP Amplitude proxy", ts: day(19) },
      { text: "ok and the dual send?", ts: day(19) },
    ]);
    chat(path("ask-metrics"), [{ text: "add the Amplitude turn event", ts: day(12) }]);
    const r = await lookup.call("me", { query: "cos-634" });
    expect(r.text).toStartWith('1 worktree of this project matches "cos-634".');
    expect(r.text).toContain('@toyon/double-log is the worktree "Double log"');
    expect(r.text).toContain("1 of their 2 messages mention the query.");
    expect(r.text).not.toContain("@toyon/ask-metrics");
  });

  test("every word has to be there, across the title, the branch and the chat together", async () => {
    const { lookup, chat, path } = make([
      row("me", "Me"),
      row("double-log", "Double log"),
      row("ask-metrics", "Ask metrics"),
    ]);
    chat(path("double-log"), [{ text: "Databricks through the proxy", ts: day(19) }]);
    chat(path("ask-metrics"), [{ text: "the Amplitude turn event", ts: day(12) }]);
    const both = await lookup.call("me", { query: "Databricks log" });
    expect(both.text).toContain("@toyon/double-log");
    expect(both.text).not.toContain("@toyon/ask-metrics");
    const amp = await lookup.call("me", { query: "amplitude" });
    expect(amp.text).toContain("@toyon/ask-metrics");
    expect(amp.text).not.toContain("@toyon/double-log");
  });

  test("nothing found says what was searched", async () => {
    const { lookup } = make([row("me", "Me"), row("a", "A")], [gone("z", "Z", "/none")]);
    const r = await lookup.call("me", { query: "unicorn" });
    expect(r.text).toBe(
      'No worktree of this project matches "unicorn". Searched 1 open and 1 archived by title, branch and what the person wrote in each chat.',
    );
  });

  test("a blank query lists everything, and another project's rows are never seen", async () => {
    const { lookup } = make([row("me", "Me"), row("a", "A"), { ...row("other", "Other"), repoId: "elsewhere" }]);
    const r = await lookup.call("me", { query: "   " });
    expect(r.text).toContain("@toyon/a ");
    expect(r.text).not.toContain("@toyon/other");
  });
});
