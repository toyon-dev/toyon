// What a turn cost and how full the context is, in a form that reads at a glance. The agent
// reports cumulative figures (the session's spend so far, the context as of the last reply), so
// the per-turn number is a difference the store already took; this only formats.

import type { AgentLimits } from "@toyon/shared";

/** tokens as people say them: 812, 9.5k, 42k, 200k */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

/** dollars to the cent, and "<$0.01" rather than "$0.00" for a turn that cost something */
export function dollars(amount: number): string {
  if (amount > 0 && amount < 0.005) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

/** whether compacting is worth it at this fill: a summary drops detail the agent may still need,
 * so it is advice against while there is room, and for a pause between tasks once there is not */
export function compactAdvice(fraction: number): string {
  const full = `${Math.round(100 * fraction)}% full`;
  if (fraction < 0.5) return `${full}: plenty of room, no need yet`;
  if (fraction < 0.8) return `${full}: worth doing between tasks`;
  return `${full}: do it before the next task`;
}

/** the same advice for the ring's tooltip, which already gives the fill: only once there is
 * something to do, since "no need yet" answers a question a hover has not asked */
export function compactNudge(fraction: number): string | undefined {
  if (fraction < 0.5) return undefined;
  return fraction < 0.8 ? "worth compacting between tasks" : "compact before the next task";
}

// ---- the plan's windows, the account's rather than this worktree's ----

type WindowKey = keyof AgentLimits["windows"];
const WINDOW_KEYS: WindowKey[] = ["five_hour", "seven_day"];
/** the window in a phrase ("43% of the 5-hour window") and at the head of its panel row */
const WINDOW_PHRASE: Record<WindowKey, string> = { five_hour: "the 5-hour window", seven_day: "the week" };
const WINDOW_NAME: Record<WindowKey, string> = { five_hour: "5-hour", seven_day: "this week" };

/** a window still running: one past its reset has emptied, and nothing has read it since */
function running(limits: AgentLimits, now: number): Array<{ key: WindowKey; used: number; resetsAt: number }> {
  return WINDOW_KEYS.flatMap((key) => {
    const w = limits.windows[key];
    return w && w.resetsAt > now ? [{ key, used: w.used, resetsAt: w.resetsAt }] : [];
  });
}

/** the window nearest its cap, as the fraction the ring's level draws: empty once every window
 * has reset, until the next reply reads them again */
export function limitLevel(limits: AgentLimits, now: number): number {
  return Math.min(1, Math.max(0, ...running(limits, now).map((w) => w.used)));
}

const pct = (used: number) => `${Math.round(100 * used)}%`;

/** the windows in one glance, for the hover: "43% of the 5-hour window, 19% of the week" */
export function limitSummary(limits: AgentLimits, now: number): string {
  const parts = running(limits, now).map((w) => `${pct(w.used)} of ${WINDOW_PHRASE[w.key]}`);
  return parts.length ? parts.join(", ") : "plan windows reset";
}

/** when a window empties, for its line: the clock when that is today, the date and clock when not */
export function resetWord(resetsAt: number, now: number, locale?: string): string {
  const then = new Date(resetsAt);
  const today = new Date(now);
  const sameDay = then.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(then);
}

export interface LimitRow {
  key: WindowKey;
  name: string;
  /** the fraction spent, as reported: past 1 when the window is overrun */
  used: number;
  /** the line under the bar: when it resets, with the agent's warning when the window is the one
   * it is about; or that it has reset and nothing has read it since */
  sub: string;
}

/** a row per window for the panel, in the order Claude Code's own usage screen lists them.
 * `when` words a reset time; the default reads the clock in the person's locale. */
export function limitRows(limits: AgentLimits, now: number, when = (ms: number) => resetWord(ms, now)): LimitRow[] {
  return WINDOW_KEYS.flatMap((key) => {
    const w = limits.windows[key];
    if (!w) return [];
    const name = WINDOW_NAME[key];
    if (w.resetsAt <= now)
      return [{ key, name, used: 0, sub: `reset ${when(w.resetsAt)}, read again on the next reply` }];
    const warn =
      limits.binding === key && limits.status === "rejected"
        ? ", out until then"
        : limits.binding === key && limits.status === "allowed_warning"
          ? ", nearly out"
          : "";
    return [{ key, name, used: w.used, sub: `resets ${when(w.resetsAt)}${warn}` }];
  });
}
