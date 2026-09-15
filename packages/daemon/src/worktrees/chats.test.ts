import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@toyon/shared";
import type { TranscriptEntry } from "../agent/transcript.ts";
import type { StateStore } from "../core/state.ts";
import { CHAT_HITS_PER_WORKTREE, type ChatFs, ChatSearch, saidRows, searchRows, snippet } from "./chats.ts";

const e = (seq: number, event: AgentEvent): TranscriptEntry => ({ seq, event });
const said = (seq: number, text: string, ts: number) => e(seq, { type: "user-message", text, ts });
const jsonl = (entries: TranscriptEntry[]) => entries.map((x) => `${JSON.stringify(x)}\n`).join("");

describe("saidRows", () => {
  test("a message is a row, and a run of prose is one row named by its first seq with its turn's time", () => {
    const rows = saidRows([
      said(0, "tidy the footer", 10),
      e(1, { type: "turn-start", ts: 11 }),
      e(2, { type: "thinking-delta", text: "the footer, then" }),
      e(3, { type: "tool-start", toolId: "t1", name: "Edit", input: { path: "footer.tsx" }, title: "Edit footer.tsx" }),
      e(4, { type: "tool-end", toolId: "t1", output: "footer.tsx written" }),
      e(5, { type: "text-delta", text: "Done: the footer's\nlinks" }),
      e(6, { type: "text-delta", text: " sit in one row." }),
      e(7, { type: "turn-end", stopReason: "end_turn", ts: 12 }),
    ]);
    expect(rows.map(({ seq, role, text, ts }) => ({ seq, role, text, ts }))).toEqual([
      { seq: 0, role: "user", text: "tidy the footer", ts: 10 },
      { seq: 5, role: "assistant", text: "Done: the footer's links sit in one row.", ts: 11 },
    ]);
  });
});

describe("snippet", () => {
  test("a long message is cut around the match, and the match is still where it says", () => {
    const text = `${"a".repeat(120)} needle ${"b".repeat(120)}`;
    const s = snippet(text, text.indexOf("needle"), 6);
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.text.slice(s.match[0], s.match[0] + s.match[1])).toBe("needle");
  });
  test("a short message is whole", () => {
    expect(snippet("fix the needle", 8, 6)).toEqual({ text: "fix the needle", match: [8, 6] });
  });
});

describe("searchRows", () => {
  test("case does not matter, the newest comes first, and a chat gives up at its limit", () => {
    const rows = saidRows(Array.from({ length: 25 }, (_, i) => said(i, `the FOOTER, take ${i}`, i)));
    const { hits, more } = searchRows(rows, "footer", { worktreeId: "a", archived: false });
    expect(hits).toHaveLength(CHAT_HITS_PER_WORKTREE);
    expect(more).toBe(true);
    expect(hits[0]).toMatchObject({ worktreeId: "a", seq: 24, role: "user", ts: 24 });
  });
});

describe("ChatSearch", () => {
  const make = () => {
    const files = new Map<string, { text: string; mtimeMs: number }>([
      ["/t/m.jsonl", { text: jsonl([said(0, "the footer on main", 30)]), mtimeMs: 1 }],
      ["/t/x.jsonl", { text: jsonl([said(0, "the footer elsewhere", 40)]), mtimeMs: 1 }],
      ["/t/b.jsonl", { text: jsonl([said(0, "the footer, cold", 15)]), mtimeMs: 1 }],
      ["/arch/z.jsonl", { text: jsonl([said(0, "the footer again", 20)]), mtimeMs: 1 }],
    ]);
    let reads = 0;
    const fs: ChatFs = {
      stat: async (p) => {
        const f = files.get(p);
        return f ? { size: f.text.length, mtimeMs: f.mtimeMs } : null;
      },
      text: async (p) => {
        reads++;
        return files.get(p)?.text ?? null;
      },
    };
    const state = {
      requireRepo: () => ({}),
      worktrees: [
        { id: "a", repoId: "r", kind: "worktree" },
        { id: "b", repoId: "r", kind: "worktree" },
        { id: "m", repoId: "r", kind: "main" },
        { id: "x", repoId: "other", kind: "worktree" },
      ],
    } as unknown as StateStore;
    const search = new ChatSearch({
      state,
      live: (id) => (id === "a" ? [said(0, "fix the footer", 5)] : undefined),
      transcriptPath: (id) => `/t/${id}.jsonl`,
      archivedChats: () => [{ id: "z", transcript: "/arch/z.jsonl" }],
      fs,
    });
    return { search, files, reads: () => reads };
  };

  test("the project's worktrees and archived chats, main and other projects left out, where it was said last first", async () => {
    const { search } = make();
    const { hits, truncated } = await search.search("r", "Footer");
    expect(hits.map((h) => [h.worktreeId, h.archived])).toEqual([
      ["z", true],
      ["b", false],
      ["a", false],
    ]);
    expect(truncated).toBe(false);
  });

  test("a chat's file is read again only when it changes, and a short query reads nothing", async () => {
    const { search, files, reads } = make();
    await search.search("r", "footer");
    expect(reads()).toBe(2);
    await search.search("r", "footer again");
    expect(reads()).toBe(2);
    files.get("/t/b.jsonl")!.mtimeMs = 2;
    await search.search("r", "footer");
    expect(reads()).toBe(3);
    expect(await search.search("r", "f")).toEqual({ hits: [], truncated: false });
    expect(reads()).toBe(3);
  });
});
