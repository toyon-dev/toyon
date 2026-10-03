import { describe, expect, test } from "bun:test";
import type { AttachmentInput } from "@toyon/shared";
import { unparsedReply } from "./ws.ts";

const items: AttachmentInput[] = [{ kind: "file", upload: "u1", name: "run.jsonl", bytes: 9, text: true }];
const drafts = {
  text: (boxId: string) => (boxId === "a" ? "what failed here" : ""),
  attachments: (boxId: string) => (boxId === "a" ? items : []),
};

describe("a frame that did not parse", () => {
  test("a send is answered unsent, with its box as the daemon still holds it", () => {
    const frame = { t: "chat", worktreeId: "a", text: "x".repeat(10), attachments: "not a list", boxId: "a" };
    expect(unparsedReply(frame, "attachments: expected array", drafts)).toEqual({
      t: "unsent",
      boxId: "a",
      text: "what failed here",
      items,
      message: "invalid message: attachments: expected array",
    });
  });

  test("anything else, or a send that names no box, is told the reason alone", () => {
    const error = { t: "error" as const, message: "invalid message: bad" };
    expect(unparsedReply({ t: "set-attachments", boxId: "a", items: 3 }, "bad", drafts)).toEqual(error);
    expect(unparsedReply({ t: "chat", worktreeId: "a" }, "bad", drafts)).toEqual(error);
    expect(unparsedReply({ t: "chat", boxId: 7 }, "bad", drafts)).toEqual(error);
    expect(unparsedReply(null, "bad", drafts)).toEqual(error);
  });
});
