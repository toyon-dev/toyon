import { describe, expect, test } from "bun:test";
import { PASTE_MAX_CHARS, PASTES_PER_MESSAGE, parseClientMsg } from "./ws.ts";

describe("parseClientMsg", () => {
  test("accepts every well-formed kind it is given", () => {
    for (const msg of [
      { t: "subscribe", worktreeId: "a" },
      { t: "chat", worktreeId: "a", text: "hi" },
      {
        t: "chat",
        worktreeId: "a",
        text: "hi",
        pick: { component: null, file: null, line: null, tag: "div", selector: "div" },
      },
      { t: "create-worktree", repoId: "r", prompt: "x", variant: { group: "g", index: 1, of: 2 } },
      { t: "create-worktree", repoId: "r", prompt: "x", agent: "codex" },
      { t: "batch-worktrees", repoId: "r", prompt: "x", agent: "claude" },
      { t: "set-default-agent", agent: "codex" },
      { t: "install-agent", agent: "codex" },
      { t: "agent-auth", worktreeId: "a", methodId: "api-key", apiKey: "sk-x" },
      { t: "agent-retry", worktreeId: "a" },
      { t: "agent-answer", worktreeId: "a", askId: "k1", answers: [{ selected: ["yes"], note: "with a caveat" }] },
      // no answers at all is the skip button
      { t: "agent-answer", worktreeId: "a", askId: "k1" },
      { t: "agent-decide", worktreeId: "a", askId: "k1", choiceId: "allow_once" },
      { t: "agent-logout", agent: "codex" },
      { t: "combine", worktreeIds: ["a", "b"] },
      { t: "confirm-config", repoId: "r", config: { procs: { web: "bun dev" } } },
      {
        t: "confirm-config",
        repoId: "r",
        config: {
          procs: { web: "w", api: "a" },
          profiles: { full: { procs: ["api", "web"], env: { X: "$API_URL" } }, fe: { procs: ["web"], preview: "web" } },
          defaultProfile: "fe",
        },
      },
      { t: "create-worktree", repoId: "r", prompt: "x", profile: "fe" },
      { t: "chat", worktreeId: "a", text: "hi", pastes: [{ text: "a\nb" }] },
      { t: "chat", worktreeId: "a", text: "hi", pastes: [{ text: "x", name: "App.tsx" }] },
      { t: "create-worktree", repoId: "r", prompt: "x", pastes: [{ text: "x" }] },
      { t: "list-commands", worktreeId: "a" },
      { t: "set-worktree-profile", worktreeId: "a", profile: "full" },
      { t: "set-theme", prefs: { mode: "system", light: "l", dark: "d" } },
      { t: "rescan-themes" },
      { t: "term-open", worktreeId: "a", stream: "shell", cols: 80, rows: 24 },
      { t: "term-input", worktreeId: "a", stream: "shell", data: "ls\r" },
      { t: "term-resize", worktreeId: "a", stream: "web", cols: 1, rows: 500 },
      { t: "term-restart", worktreeId: "a", stream: "web" },
      { t: "term-close", worktreeId: "a", stream: "shell" },
    ]) {
      const r = parseClientMsg(msg);
      expect(r.ok, JSON.stringify(msg)).toBe(true);
    }
  });

  test("rejects non-objects and unknown kinds", () => {
    expect(parseClientMsg(null).ok).toBe(false);
    expect(parseClientMsg("subscribe").ok).toBe(false);
    expect(parseClientMsg({ t: "nope" }).ok).toBe(false);
  });

  test("names the offending field", () => {
    const r = parseClientMsg({ t: "confirm-config", repoId: "r", config: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/config\.procs/);
    const w = parseClientMsg({ t: "write-file", worktreeId: "a", path: "", content: "" });
    if (!w.ok) expect(w.reason).toMatch(/^path/);
    const a = parseClientMsg({ t: "agent-answer", worktreeId: "a", askId: "k", answers: [{ selected: "one" }] });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toMatch(/answers/);
  });

  test("an ask answer is bounded: a browser sends it, and a card can be old", () => {
    const answer = (answers: unknown) => parseClientMsg({ t: "agent-answer", worktreeId: "a", askId: "k", answers });
    expect(answer([{ selected: Array.from({ length: 33 }, () => "x") }]).ok).toBe(false);
    expect(answer(Array.from({ length: 9 }, () => ({ selected: [] }))).ok).toBe(false);
    expect(answer([{ selected: ["x"], note: "n".repeat(10_001) }]).ok).toBe(false);
    expect(answer([{ selected: ["x"], note: "n".repeat(10_000) }]).ok).toBe(true);
    // a decision needs the option it is deciding for
    expect(parseClientMsg({ t: "agent-decide", worktreeId: "a", askId: "k" }).ok).toBe(false);
  });

  test("profiles must name real procs, a default, and a preview inside the profile", () => {
    const cfg = (config: unknown) => parseClientMsg({ t: "confirm-config", repoId: "r", config });
    const procs = { web: "w", api: "a" };
    const bad = [
      { procs, profiles: { a: { procs: ["nope"] } }, defaultProfile: "a" },
      { procs, profiles: { a: { procs: ["web"] } } },
      { procs, profiles: { a: { procs: ["web"] } }, defaultProfile: "b" },
      { procs, profiles: { a: { procs: ["web"], preview: "api" } }, defaultProfile: "a" },
      { procs, defaultProfile: "a" },
    ];
    for (const c of bad) expect(cfg(c).ok, JSON.stringify(c)).toBe(false);
    const r = cfg(bad[0]);
    if (!r.ok) expect(r.reason).toMatch(/profiles\.a\.procs: unknown proc "nope"/);
  });

  test("a paste must have text, and there are caps on size and count", () => {
    const chat = (pastes: unknown) => parseClientMsg({ t: "chat", worktreeId: "a", text: "hi", pastes });
    expect(chat([{ text: "" }]).ok).toBe(false);
    expect(chat([{ text: "x".repeat(PASTE_MAX_CHARS + 1) }]).ok).toBe(false);
    expect(chat(Array(PASTES_PER_MESSAGE + 1).fill({ text: "x" })).ok).toBe(false);
    expect(chat(Array(PASTES_PER_MESSAGE).fill({ text: "x" })).ok).toBe(true);
    const r = chat([{ text: "" }]);
    if (!r.ok) expect(r.reason).toMatch(/^pastes/);
  });

  test("combine needs at least two worktrees; unqueue index is a non-negative integer", () => {
    expect(parseClientMsg({ t: "combine", worktreeIds: ["a"] }).ok).toBe(false);
    expect(parseClientMsg({ t: "unqueue", worktreeId: "a", index: -1 }).ok).toBe(false);
    expect(parseClientMsg({ t: "unqueue", worktreeId: "a", index: 1.5 }).ok).toBe(false);
  });

  test("terminal sizes are 1-500 integers and input is bounded", () => {
    const open = (cols: number, rows: number) =>
      parseClientMsg({ t: "term-open", worktreeId: "a", stream: "shell", cols, rows });
    expect(open(0, 24).ok).toBe(false);
    expect(open(80, 501).ok).toBe(false);
    expect(open(80.5, 24).ok).toBe(false);
    const r = open(0, 24);
    if (!r.ok) expect(r.reason).toMatch(/^cols/);
    expect(parseClientMsg({ t: "term-input", worktreeId: "a", stream: "shell", data: "x".repeat(65_537) }).ok).toBe(
      false,
    );
  });

  test("unknown extra fields are dropped, not rejected", () => {
    const r = parseClientMsg({ t: "subscribe", worktreeId: "a", extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect("extra" in r.msg).toBe(false);
  });
});
