import { describe, expect, test } from "bun:test";
import type { AgentLimits } from "@toyon/shared";
import {
  accountLine,
  compactAdvice,
  compactNudge,
  dollars,
  limitLevel,
  limitRows,
  limitSummary,
  resetWord,
  tokens,
} from "./usage.ts";

describe("tokens", () => {
  test("reads like speech", () => {
    expect(tokens(812)).toBe("812");
    expect(tokens(9_540)).toBe("9.5k");
    expect(tokens(10_000)).toBe("10k");
    expect(tokens(42_300)).toBe("42k");
    expect(tokens(200_000)).toBe("200k");
  });
});

describe("dollars", () => {
  test("to the cent, and never a zero for something that cost", () => {
    expect(dollars(0)).toBe("$0.00");
    expect(dollars(0.004)).toBe("<$0.01");
    expect(dollars(0.12)).toBe("$0.12");
    expect(dollars(1.036)).toBe("$1.04");
  });
});

describe("compactAdvice", () => {
  test("argues against while there is room, and for once there is not", () => {
    expect(compactAdvice(0.12)).toBe("12% full: plenty of room, no need yet");
    expect(compactAdvice(0.64)).toBe("64% full: worth doing between tasks");
    expect(compactAdvice(0.91)).toBe("91% full: do it before the next task");
  });
});

describe("compactNudge", () => {
  test("says nothing while there is room", () => {
    expect(compactNudge(0.12)).toBeUndefined();
    expect(compactNudge(0.64)).toBe("worth compacting between tasks");
    expect(compactNudge(0.91)).toBe("compact before the next task");
  });
});

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const both: AgentLimits = {
  status: "allowed",
  binding: "five_hour",
  windows: {
    five_hour: { used: 0.75, resetsAt: NOW + HOUR },
    seven_day: { used: 0.09, resetsAt: NOW + 5 * 24 * HOUR },
  },
  at: NOW,
};
const clock = (ms: number) => `t+${(ms - NOW) / HOUR}h`;

describe("accountLine", () => {
  test("the email and the plan for an account; nothing for a key, a gateway or silence", () => {
    expect(
      accountLine({ kind: "account", label: "Claude Max", account: { email: "k@example.com", plan: "max" } }),
    ).toBe("k@example.com · Claude Max");
    expect(accountLine({ kind: "account", label: "Claude Pro" })).toBe("Claude Pro");
    expect(accountLine({ kind: "api_key", label: "Anthropic API key", detail: "env" })).toBeUndefined();
    expect(accountLine({ kind: "none", label: "not logged in" })).toBeUndefined();
    expect(accountLine(undefined)).toBeUndefined();
  });
});

describe("limitLevel", () => {
  test("draws the window nearest its cap, and nothing once every window has reset", () => {
    expect(limitLevel(both, NOW)).toBe(0.75);
    expect(limitLevel(both, NOW + 2 * HOUR)).toBe(0.09);
    expect(limitLevel(both, NOW + 6 * 24 * HOUR)).toBe(0);
  });

  test("an overrun window is full, not more than full", () => {
    expect(limitLevel({ ...both, windows: { five_hour: { used: 1.2, resetsAt: NOW + HOUR } } }, NOW)).toBe(1);
  });
});

describe("limitSummary", () => {
  test("every running window in one glance, and a word for none", () => {
    expect(limitSummary(both, NOW)).toBe("75% of the 5-hour window, 9% of the week");
    expect(limitSummary(both, NOW + 2 * HOUR)).toBe("9% of the week");
    expect(limitSummary(both, NOW + 6 * 24 * HOUR)).toBe("plan windows reset");
  });
});

describe("limitRows", () => {
  test("a row per window, in the order the agent's own usage screen lists them", () => {
    expect(limitRows(both, NOW, clock)).toEqual([
      { key: "five_hour", name: "5-hour", used: 0.75, sub: "resets t+1h" },
      { key: "seven_day", name: "this week", used: 0.09, sub: "resets t+120h" },
    ]);
  });

  test("the agent's warning lands on the window it is about", () => {
    expect(limitRows({ ...both, status: "allowed_warning" }, NOW, clock)[0]?.sub).toBe("resets t+1h, nearly out");
    expect(limitRows({ ...both, status: "rejected" }, NOW, clock).map((r) => r.sub)).toEqual([
      "resets t+1h, out until then",
      "resets t+120h",
    ]);
    expect(limitRows({ ...both, binding: "seven_day_opus", status: "rejected" }, NOW, clock)[0]?.sub).toBe(
      "resets t+1h",
    );
  });

  test("a window past its reset says so rather than showing a figure nobody has read since", () => {
    expect(limitRows(both, NOW + 2 * HOUR, clock)[0]).toEqual({
      key: "five_hour",
      name: "5-hour",
      used: 0,
      sub: "reset t+1h, read again on the next reply",
    });
    expect(limitRows({ ...both, windows: { seven_day: both.windows.seven_day } }, NOW, clock)).toHaveLength(1);
  });
});

describe("resetWord", () => {
  test("the clock alone for today, the date as well for another day", () => {
    const noon = new Date(2026, 9, 6, 12, 0).getTime();
    expect(resetWord(new Date(2026, 9, 6, 19, 9).getTime(), noon, "en-US")).toBe("7:09 PM");
    // the joiner between date and clock is ICU's and has changed across versions
    expect(resetWord(new Date(2026, 9, 11, 8, 59).getTime(), noon, "en-US")).toMatch(/^Oct 11(,| at) 8:59 AM$/);
  });
});
