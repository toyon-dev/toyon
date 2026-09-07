import { describe, expect, test } from "bun:test";
import { parseClientMsg } from "./ws.ts";

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
      { t: "combine", worktreeIds: ["a", "b"] },
      { t: "confirm-config", repoId: "r", config: { procs: { web: "bun dev" } } },
      { t: "set-theme", prefs: { mode: "system", light: "l", dark: "d" } },
      { t: "rescan-themes" },
      { t: "term-open", worktreeId: "a", cols: 80, rows: 24 },
      { t: "term-input", worktreeId: "a", data: "ls\r" },
      { t: "term-resize", worktreeId: "a", cols: 1, rows: 500 },
      { t: "term-kill", worktreeId: "a" },
      { t: "term-close", worktreeId: "a" },
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
  });

  test("combine needs at least two worktrees; unqueue index is a non-negative integer", () => {
    expect(parseClientMsg({ t: "combine", worktreeIds: ["a"] }).ok).toBe(false);
    expect(parseClientMsg({ t: "unqueue", worktreeId: "a", index: -1 }).ok).toBe(false);
    expect(parseClientMsg({ t: "unqueue", worktreeId: "a", index: 1.5 }).ok).toBe(false);
  });

  test("terminal sizes are 1–500 integers and input is bounded", () => {
    const open = (cols: number, rows: number) => parseClientMsg({ t: "term-open", worktreeId: "a", cols, rows });
    expect(open(0, 24).ok).toBe(false);
    expect(open(80, 501).ok).toBe(false);
    expect(open(80.5, 24).ok).toBe(false);
    const r = open(0, 24);
    if (!r.ok) expect(r.reason).toMatch(/^cols/);
    expect(parseClientMsg({ t: "term-input", worktreeId: "a", data: "x".repeat(65_537) }).ok).toBe(false);
  });

  test("unknown extra fields are dropped, not rejected", () => {
    const r = parseClientMsg({ t: "subscribe", worktreeId: "a", extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect("extra" in r.msg).toBe(false);
  });
});
