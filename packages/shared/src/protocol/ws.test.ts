import { describe, expect, test } from "bun:test";
import { ATTACHMENT_LIMITS } from "../attachment.ts";
import { PASTE_MAX_CHARS } from "./limits.ts";
import { issueReason, parseClientMsg, toyonConfigSchema } from "./ws.ts";

describe("toyonConfigSchema", () => {
  // the terminal pane's shell tab is the stream named "shell", so a proc by that name would be unreachable
  test("refuses a proc named shell, and says why rather than that a key was invalid", () => {
    expect(toyonConfigSchema.safeParse({ run: { web: "bun dev" } }).success).toBe(true);
    const r = toyonConfigSchema.safeParse({ run: { shell: "bun dev" } });
    expect(r.success).toBe(false);
    expect(r.error && issueReason(r.error, "invalid")).toBe('run.shell: "shell" is reserved for the shell tab');
  });

  test("check is one shell command, or absent", () => {
    expect(toyonConfigSchema.safeParse({ run: {}, check: "bun run check" }).success).toBe(true);
    expect(toyonConfigSchema.safeParse({ run: {}, check: ["bun run check"] }).success).toBe(false);
  });
});

describe("parseClientMsg", () => {
  test("accepts every well-formed kind it is given", () => {
    for (const msg of [
      { t: "subscribe", worktreeId: "a" },
      { t: "design-scan", worktreeId: "a" },
      { t: "chat", worktreeId: "a", text: "hi" },
      {
        t: "chat",
        worktreeId: "a",
        text: "hi",
        attachments: [
          { kind: "pick", component: null, file: null, line: null, tag: "div", selector: "div", text: "", html: "" },
        ],
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
      { t: "graft", targetId: "a", sourceIds: ["b"] },
      { t: "confirm-config", repoId: "r", config: { run: { web: "bun dev" } }, kind: "local" },
      {
        t: "confirm-config",
        repoId: "r",
        config: {
          run: { web: "w", api: "a" },
          profiles: { full: { run: ["api", "web"], env: { X: "$API_URL" } }, fe: { run: ["web"], preview: "web" } },
          defaultProfile: "fe",
        },
        kind: "shared",
      },
      { t: "create-worktree", repoId: "r", prompt: "x", profile: "fe" },
      { t: "create-worktree", repoId: "r", prompt: "x", model: "big", effort: "high" },
      { t: "set-worktree-effort", worktreeId: "a", effort: "high" },
      { t: "chat", worktreeId: "a", text: "hi", attachments: [{ kind: "paste", text: "a\nb" }] },
      { t: "chat", worktreeId: "a", text: "hi", attachments: [{ kind: "paste", text: "x", name: "App.tsx" }] },
      { t: "create-worktree", repoId: "r", prompt: "x", attachments: [{ kind: "paste", text: "x" }] },
      { t: "list-commands", worktreeId: "a" },
      { t: "set-worktree-profile", worktreeId: "a", profile: "full" },
      { t: "set-theme", prefs: { mode: "system", light: "l", dark: "d" } },
      { t: "rescan-themes" },
      { t: "term-open", worktreeId: "a", stream: "shell", cols: 80, rows: 24 },
      { t: "term-input", worktreeId: "a", stream: "shell", data: "ls\r" },
      { t: "term-resize", worktreeId: "a", stream: "web", cols: 1, rows: 500 },
      { t: "term-restart", worktreeId: "a", stream: "web" },
      { t: "term-close", worktreeId: "a", stream: "shell" },
      { t: "visit", worktreeId: "a", path: "/pricing" },
      { t: "visit", worktreeId: "a", path: "/pricing", title: "Pricing | Acme" },
      { t: "page-title", worktreeId: "a", path: "/pricing", title: "Pricing | Acme" },
      { t: "forget-visit", repoId: "r", path: "/#/about" },
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
    const r = parseClientMsg({ t: "confirm-config", repoId: "r", config: {}, kind: "local" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/config\.run/);
    // committed or kept local is the shell's to say, never guessed here
    expect(parseClientMsg({ t: "confirm-config", repoId: "r", config: { run: {} } }).ok).toBe(false);
    const w = parseClientMsg({ t: "write-file", worktreeId: "a", path: "", content: "", base: null, seq: 0 });
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

  test("profiles must name real processes, a default, and a preview inside the profile", () => {
    const cfg = (config: unknown) => parseClientMsg({ t: "confirm-config", repoId: "r", config, kind: "local" });
    const run = { web: "w", api: "a" };
    const bad = [
      { run, profiles: { a: { run: ["nope"] } }, defaultProfile: "a" },
      { run, profiles: { a: { run: ["web"] } } },
      { run, profiles: { a: { run: ["web"] } }, defaultProfile: "b" },
      { run, profiles: { a: { run: ["web"], preview: "api" } }, defaultProfile: "a" },
      { run, defaultProfile: "a" },
    ];
    for (const c of bad) expect(cfg(c).ok, JSON.stringify(c)).toBe(false);
    const r = cfg(bad[0]);
    if (!r.ok) expect(r.reason).toMatch(/profiles\.a\.run: "nope" is not in run/);
  });

  test("a paste must have text, and there are caps on size and on each kind's count", () => {
    const chat = (attachments: unknown) => parseClientMsg({ t: "chat", worktreeId: "a", text: "hi", attachments });
    const paste = (text: string) => ({ kind: "paste", text });
    const pick = {
      kind: "pick",
      component: null,
      file: null,
      line: null,
      tag: "div",
      selector: "div",
      text: "",
      html: "",
    };
    expect(chat([paste("")]).ok).toBe(false);
    expect(chat([paste("x".repeat(PASTE_MAX_CHARS + 1))]).ok).toBe(false);
    expect(chat(Array(ATTACHMENT_LIMITS.paste + 1).fill(paste("x"))).ok).toBe(false);
    // a full count of one kind leaves every other kind its own room
    const full = [...Array(ATTACHMENT_LIMITS.paste).fill(paste("x")), ...Array(ATTACHMENT_LIMITS.pick).fill(pick)];
    expect(chat(full).ok).toBe(true);
    const r = chat([paste("")]);
    if (!r.ok) expect(r.reason).toMatch(/^attachments/);
    const over = chat(Array(ATTACHMENT_LIMITS.pick + 1).fill(pick));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain(`at most ${ATTACHMENT_LIMITS.pick} elements per message`);
  });
  test("an attachment of no known kind is refused", () => {
    expect(parseClientMsg({ t: "chat", worktreeId: "a", text: "hi", attachments: [{ kind: "video" }] }).ok).toBe(false);
  });

  test("graft needs a source; unqueue index is a non-negative integer", () => {
    expect(parseClientMsg({ t: "graft", targetId: "a", sourceIds: [] }).ok).toBe(false);
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

  test("a visit names a page, and a page is bounded", () => {
    expect(parseClientMsg({ t: "visit", worktreeId: "a", path: "" }).ok).toBe(false);
    expect(parseClientMsg({ t: "visit", worktreeId: "a", path: `/${"x".repeat(2_000)}` }).ok).toBe(false);
    expect(parseClientMsg({ t: "forget-visit", repoId: "r" }).ok).toBe(false);
    // a title is bounded before the daemon ever trims it, and a rename needs one
    expect(parseClientMsg({ t: "visit", worktreeId: "a", path: "/a", title: "x".repeat(1_001) }).ok).toBe(false);
    expect(parseClientMsg({ t: "page-title", worktreeId: "a", path: "/a" }).ok).toBe(false);
  });

  test("unknown extra fields are dropped, not rejected", () => {
    const r = parseClientMsg({ t: "subscribe", worktreeId: "a", extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect("extra" in r.msg).toBe(false);
  });
});
