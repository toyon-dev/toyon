import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstPrompt } from "./archive.ts";

// The one line an archived row shows for what the work was: the first message, or for a worktree
// born with a plan another agent wrote, that plan's first paragraph.

describe("firstPrompt", () => {
  const line = (event: unknown) => `${JSON.stringify({ seq: 0, event })}\n`;

  test("a person's first message, cut to a row's length; nothing from a transcript with no message", () => {
    const dir = mkdtempSync(join(tmpdir(), "toyon-archive-"));
    try {
      const transcript = join(dir, "t.jsonl");
      writeFileSync(
        transcript,
        line({ type: "turn-start", ts: 1 }) + line({ type: "user-message", text: "fix the rail", ts: 2 }),
      );
      expect(firstPrompt(transcript)).toBe("fix the rail");
      writeFileSync(transcript, line({ type: "turn-start", ts: 1 }));
      expect(firstPrompt(transcript)).toBeUndefined();
      expect(firstPrompt(join(dir, "missing.jsonl"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a worktree born with a plan, or a piece sent on, is summed up by the text itself, else by the message", () => {
    const dir = mkdtempSync(join(tmpdir(), "toyon-archive-"));
    try {
      const transcript = join(dir, "t.jsonl");
      const handed = {
        type: "handed",
        via: "plan",
        text: "Your plan is at .toyon/plans/1.md. It was written by",
        body: "Send only what the page lacks.",
        path: ".toyon/plans/1.md",
        origin: { id: "a", repoId: "r", branch: "toyon/rail", title: "Rail" },
        ts: 2,
      };
      writeFileSync(transcript, line(handed));
      expect(firstPrompt(transcript)).toBe("Send only what the page lacks.");
      writeFileSync(transcript, line({ ...handed, body: undefined }));
      expect(firstPrompt(transcript)).toBe("Your plan is at .toyon/plans/1.md. It was written by");
      writeFileSync(transcript, line({ ...handed, via: "message", path: undefined, body: "Add the notes." }));
      expect(firstPrompt(transcript)).toBe("Add the notes.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
