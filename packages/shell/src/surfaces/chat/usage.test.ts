import { describe, expect, test } from "bun:test";
import type { AgentLimits } from "@toyon/shared";
import {
  compactAdvice,
  compactNudge,
  dollars,
  limitLabel,
  limitLevel,
  limitLines,
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

describe("limitLabel", () => {
  test("names the fullest window, and says so when none is running", () => {
    expect(limitLabel(both, NOW)).toBe("75% of the 5-hour limit");
    expect(limitLabel(both, NOW + 2 * HOUR)).toBe("9% of the weekly limit");
    expect(limitLabel(both, NOW + 6 * 24 * HOUR)).toBe("plan limits reset");
  });
});

describe("limitLines", () => {
  test("one line per window, worded like the agent's own usage screen", () => {
    expect(limitLines(both, NOW, clock)).toEqual([
      "5-hour limit: 75% used, resets t+1h",
      "weekly limit: 9% used, resets t+120h",
    ]);
  });

  test("the agent's warning lands on the window it is about", () => {
    expect(limitLines({ ...both, status: "allowed_warning" }, NOW, clock)[0]).toBe(
      "5-hour limit: 75% used, resets t+1h, nearly out",
    );
    expect(limitLines({ ...both, status: "rejected" }, NOW, clock)).toEqual([
      "5-hour limit: 75% used, resets t+1h, out until then",
      "weekly limit: 9% used, resets t+120h",
    ]);
    expect(limitLines({ ...both, binding: "seven_day_opus", status: "rejected" }, NOW, clock)[0]).toBe(
      "5-hour limit: 75% used, resets t+1h",
    );
  });

  test("a window past its reset says so rather than showing a figure nobody has read since", () => {
    expect(limitLines(both, NOW + 2 * HOUR, clock)[0]).toBe("5-hour limit: reset t+1h, read again on the next reply");
    expect(limitLines({ ...both, windows: { seven_day: both.windows.seven_day } }, NOW, clock)).toEqual([
      "weekly limit: 9% used, resets t+120h",
    ]);
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
