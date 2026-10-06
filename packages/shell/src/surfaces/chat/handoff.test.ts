import { describe, expect, test } from "bun:test";
import type { RepoInfo } from "@toyon/shared";
import type { ChatItem } from "../../state/store.ts";
import {
  cardLine,
  FOLD_LINES,
  type HandoffItem,
  handoffAnswer,
  needsFold,
  openCard,
  parseHandoffArgs,
} from "./handoff.ts";

const repo = (id: string, name = id): RepoInfo => ({
  id,
  path: `/p/${id}`,
  name,
  defaultBranch: "main",
  config: { run: {} },
  configFile: ".toyon/settings.json",
  needsSetup: false,
});

const handoff = (over: Partial<HandoffItem> = {}): HandoffItem => ({
  kind: "handoff",
  id: "h1",
  repo: { id: "r2", name: "acp", path: "/p/acp" },
  message: "bump the pin",
  by: "agent",
  mode: "auto",
  state: "proposed",
  ts: 1,
  ...over,
});

const ask = (id: string, outcome?: "answered"): ChatItem => ({
  kind: "ask",
  id,
  ask: { kind: "question", message: "Which?", questions: [] },
  ...(outcome ? { outcome } : {}),
});

describe("openCard", () => {
  test("the newest open ask or proposed handoff holds the box; closed ones do not", () => {
    expect(openCard([ask("k1"), handoff()])?.id).toBe("h1");
    expect(openCard([handoff(), ask("k1")])?.id).toBe("k1");
    expect(openCard([handoff({ state: "continued" }), ask("k1", "answered")])).toBeNull();
    expect(openCard([handoff({ state: "declined" }), ask("k1")])?.id).toBe("k1");
    expect(openCard([])).toBeNull();
  });
});

describe("cardLine", () => {
  test("a handoff's line is the question its card asks; an ask keeps its own", () => {
    expect(cardLine(handoff())).toBe("Continue in acp?");
    expect(cardLine(ask("k1") as Extract<ChatItem, { kind: "ask" }>)).toBe("Which?");
  });
});

describe("needsFold", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
  test("only a message past the fold's length folds", () => {
    expect(needsFold(lines(FOLD_LINES))).toBe(false);
    expect(needsFold(lines(FOLD_LINES + 1))).toBe(true);
  });
  test("a message holding a code fence never folds: a command must not hide under the fold", () => {
    expect(needsFold(`${lines(FOLD_LINES + 1)}\n\`\`\`sh\nrm -rf /\n\`\`\``)).toBe(false);
    expect(needsFold(`${lines(FOLD_LINES + 1)}\n~~~\nx\n~~~`)).toBe(false);
  });
});

describe("handoffAnswer", () => {
  test("the note rides with go alone, trimmed, and a blank one is left off", () => {
    expect(handoffAnswer(handoff(), "a", true, "  with care  ")).toEqual({
      t: "handoff-answer",
      worktreeId: "a",
      id: "h1",
      go: true,
      note: "with care",
    });
    expect(handoffAnswer(handoff(), "a", true, "   ")).toEqual({
      t: "handoff-answer",
      worktreeId: "a",
      id: "h1",
      go: true,
    });
    expect(handoffAnswer(handoff(), "a", true, undefined)).toEqual({
      t: "handoff-answer",
      worktreeId: "a",
      id: "h1",
      go: true,
    });
    expect(handoffAnswer(handoff(), "a", false, "kept to myself")).toEqual({
      t: "handoff-answer",
      worktreeId: "a",
      id: "h1",
      go: false,
    });
  });
});

describe("parseHandoffArgs", () => {
  const repos = [repo("r1", "toyon"), repo("r2", "claude-agent-acp"), repo("r3", "Toyon-Mono")];
  test("nothing named opens the picker", () => {
    expect(parseHandoffArgs("", repos, "r1")).toEqual({ pick: true });
    expect(parseHandoffArgs("   ", repos, "r1")).toEqual({ pick: true });
  });
  test("an exact name, whatever its case, then a unique prefix", () => {
    expect(parseHandoffArgs("claude-agent-acp", repos, "r1")).toEqual({ repo: repos[1]! });
    expect(parseHandoffArgs("CLAUDE-AGENT-ACP", repos, "r1")).toEqual({ repo: repos[1]! });
    expect(parseHandoffArgs("cla", repos, "r1")).toEqual({ repo: repos[1]! });
    // an exact match wins over the prefix it also is
    expect(parseHandoffArgs("toyon", repos, "r2")).toEqual({ repo: repos[0]! });
  });
  test("the rest is the person's own words", () => {
    expect(parseHandoffArgs("cla bump the pin  to 0.85", repos, "r1")).toEqual({
      repo: repos[1]!,
      text: "bump the pin  to 0.85",
    });
  });
  test("the refusals: too few projects, no such name, this one's own, a name shared", () => {
    expect(parseHandoffArgs("acp", [repos[0]!], "r1")).toEqual({ error: "open another project first" });
    expect(parseHandoffArgs("zed", repos, "r1")).toEqual({ error: 'no open project named "zed"' });
    expect(parseHandoffArgs("toyon", repos, "r1")).toEqual({ error: "this worktree is already in toyon" });
    expect(parseHandoffArgs("toy", repos, "r2")).toEqual({ error: '"toy" names more than one project' });
  });
});
