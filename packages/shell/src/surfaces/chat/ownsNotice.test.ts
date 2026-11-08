import { describe, expect, test } from "bun:test";
import { ownsNotice } from "./ownsNotice.ts";

describe("ownsNotice", () => {
  test("says why each proc that just flipped runs here, and nothing for a press", () => {
    expect(ownsNotice(["api"], { api: { at: { by: "edit", file: "server/routes.js" } } })).toBe(
      "Running its own api here now: this branch changed server/routes.js.",
    );
    expect(ownsNotice(["api"], { api: { at: { by: "edit" } } })).toBe(
      "Running its own api here now: this branch changed it.",
    );
    expect(ownsNotice(["api"], { api: { at: { by: "agent" } } })).toBe(
      "Running its own api here now: the agent asked for it before changing the backend.",
    );
    expect(ownsNotice(["api"], { api: { at: { by: "hand" } } })).toBeNull();
    expect(ownsNotice(["api"], undefined)).toBeNull();
    expect(ownsNotice([], { api: { at: { by: "agent" } } })).toBeNull();
  });

  test("several at once read one after the other, the pressed one left out", () => {
    expect(
      ownsNotice(["api", "db", "worker"], {
        api: { at: { by: "edit", file: "bun.lock" } },
        db: { at: { by: "hand" } },
        worker: { at: { by: "edit", file: "bun.lock" } },
      }),
    ).toBe(
      "Running its own api here now: this branch changed bun.lock. Running its own worker here now: this branch changed bun.lock.",
    );
  });
});
