import { describe, expect, test } from "bun:test";
import { machineLine } from "./machineLine.ts";

const quiet = { rows: [], connected: true, connectFailure: null, incompatible: false };

describe("machineLine", () => {
  test("what the machine needs of you, in the rail's words, waiting before unread", () => {
    expect(machineLine("work", quiet)).toBe("all quiet");
    expect(
      machineLine("work", {
        ...quiet,
        rows: [
          { id: "a", unseen: true },
          { id: "b", agent: "working" },
        ],
      }),
    ).toBe("1 unread");
    expect(
      machineLine("work", {
        ...quiet,
        rows: [
          { id: "a", unseen: true },
          { id: "b", agent: "waiting" },
        ],
      }),
    ).toBe("2 waiting");
  });
  test("why it cannot say: a protocol it does not speak first, then a held socket, then the connection", () => {
    expect(machineLine("work", { ...quiet, incompatible: true, connected: false })).toBe("update Toyon on work");
    expect(machineLine("work", { ...quiet, connected: false, suspended: true })).toBe("sleeping");
    expect(machineLine("work", { ...quiet, connected: false })).toBe("connecting");
    expect(machineLine("work", { ...quiet, connected: false, connectFailure: "down" })).toBe("not answering");
  });
});
