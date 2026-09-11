import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_LIMITS,
  ATTACHMENTS_PER_MESSAGE,
  type AttachmentKind,
  attachmentLabel,
  limitMessage,
  nextNumbers,
  numbered,
  overLimit,
  roomFor,
} from "./attachment.ts";

const of = (kind: AttachmentKind, count: number) => Array.from({ length: count }, () => ({ kind }));

describe("roomFor and overLimit", () => {
  test("each kind is bounded on its own, whatever else the message holds", () => {
    const full = [...of("image", ATTACHMENT_LIMITS.image), ...of("pick", 2)];
    expect(roomFor(full, "image")).toBe(0);
    expect(roomFor(full, "pick")).toBe(ATTACHMENT_LIMITS.pick - 2);
    expect(roomFor(full, "paste")).toBe(ATTACHMENT_LIMITS.paste);
    expect(overLimit(full)).toBeNull();
    expect(overLimit([...full, { kind: "image" }])).toBe("image");
  });
  test("the message total is every kind at its limit", () => {
    expect(ATTACHMENTS_PER_MESSAGE).toBe(ATTACHMENT_LIMITS.image + ATTACHMENT_LIMITS.paste + ATTACHMENT_LIMITS.pick);
  });
  test("a full kind is refused in words that name the kind and its limit", () => {
    expect(limitMessage("image")).toBe(`at most ${ATTACHMENT_LIMITS.image} images per message`);
    expect(limitMessage("pick")).toBe(`at most ${ATTACHMENT_LIMITS.pick} elements per message`);
  });
});

describe("nextNumbers", () => {
  test("continues each kind's count across the session, so a chip shows the number the daemon will give", () => {
    expect(nextNumbers([])).toEqual({ image: 1, paste: 1, pick: 1 });
    const sent = [
      [
        { kind: "image" as const, n: 1 },
        { kind: "pick" as const, n: 1 },
        { kind: "image" as const, n: 2 },
      ],
      undefined,
      [
        { kind: "paste" as const, n: 1 },
        { kind: "image" as const, n: 3 },
      ],
    ];
    expect(nextNumbers(sent)).toEqual({ image: 4, paste: 2, pick: 2 });
  });
});

describe("numbered", () => {
  test("numbers waiting attachments in their order, each kind counting on from the session", () => {
    const items = [...of("pick", 1), ...of("paste", 1), ...of("pick", 1), ...of("image", 1)];
    const numbers = numbered(items, { image: 3, paste: 1, pick: 1 }).map(([a, n]) => `${a.kind} ${n}`);
    expect(numbers).toEqual(["pick 1", "paste 1", "pick 2", "image 3"]);
  });
  test("leaves the counts it started from as they were", () => {
    const next = { image: 1, paste: 1, pick: 1 };
    numbered(of("image", 2), next);
    expect(next).toEqual({ image: 1, paste: 1, pick: 1 });
  });
});

describe("attachmentLabel", () => {
  test("names an image and a paste by number, the way their chips and captions both do", () => {
    expect([attachmentLabel("image", 2), attachmentLabel("paste", 1)]).toEqual(["Image 2", "Pasted text 1"]);
  });
});
