import { describe, expect, test } from "bun:test";
import { parseRateLimit } from "./ratelimit.ts";

const NOW = 1_700_000_000_000;

describe("parseRateLimit", () => {
  test("what the Claude adapter sends: both windows, with the binding one named", () => {
    expect(
      parseRateLimit(
        {
          "_claude/rateLimit": {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.75,
            resetsAt: 1_700_010_000,
            unifiedWindows: {
              five_hour: { utilization: 0.75, resetsAt: 1_700_010_000 },
              seven_day: { utilization: 0.09, resetsAt: 1_700_400_000 },
            },
          },
        },
        NOW,
      ),
    ).toEqual({
      status: "allowed",
      binding: "five_hour",
      windows: {
        five_hour: { used: 0.75, resetsAt: 1_700_010_000_000 },
        seven_day: { used: 0.09, resetsAt: 1_700_400_000_000 },
      },
      at: NOW,
    });
  });

  test("an SDK with no per-window figures still fills in the window its status is about", () => {
    expect(
      parseRateLimit(
        {
          "_claude/rateLimit": { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9, resetsAt: 5 },
        },
        NOW,
      ),
    ).toEqual({
      status: "allowed_warning",
      binding: "seven_day",
      windows: { seven_day: { used: 0.9, resetsAt: 5_000 } },
      at: NOW,
    });
  });

  test("a window overrun stays past full; a negative figure cannot be a level", () => {
    const limits = parseRateLimit(
      {
        "_claude/rateLimit": {
          status: "rejected",
          unifiedWindows: { five_hour: { utilization: 1.2, resetsAt: 1 }, seven_day: { utilization: -1, resetsAt: 1 } },
        },
      },
      NOW,
    );
    expect(limits?.windows).toEqual({
      five_hour: { used: 1.2, resetsAt: 1_000 },
      seven_day: { used: 0, resetsAt: 1_000 },
    });
    expect(limits?.binding).toBeUndefined();
  });

  test("nothing to read: no meta, another agent's meta, a status we do not know, or no window at all", () => {
    for (const junk of [
      undefined,
      null,
      {},
      { "_claude/rateLimit": null },
      { "_claude/rateLimit": "busy" },
      {
        "_claude/rateLimit": { status: "throttled", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1 } } },
      },
      { "_claude/rateLimit": { status: "allowed" } },
      { "_claude/rateLimit": { status: "allowed", rateLimitType: "overage", utilization: 0.5, resetsAt: 1 } },
      { "_claude/rateLimit": { status: "allowed", unifiedWindows: { five_hour: { utilization: "lots" } } } },
    ])
      expect(parseRateLimit(junk, NOW)).toBeNull();
  });
});
