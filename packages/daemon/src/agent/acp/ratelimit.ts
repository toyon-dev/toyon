// The Claude adapter's word on the account's plan: how much of each rate-limit window a reply
// found spent. Claude Code reads the figures off every API response and raises a rate-limit event
// when a window's rounded percentage or reset time moves; the adapter rides that event on the next
// `usage_update` as `_meta["_claude/rateLimit"]`, with the top-level status naming the window
// nearest its cap and `unifiedWindows` carrying the 5-hour and weekly windows whatever is binding.
// Push only, and only once a session has had a reply: a fresh session says nothing until then.
//
// Sessions on an API key or a gateway carry no plan and never push one. The Codex adapter keeps
// its limits to itself, so nothing is read for it here.

import type { AgentLimits, LimitWindow } from "@toyon/shared";

const RATE_LIMIT_META = "_claude/rateLimit";

const STATUSES = new Set<AgentLimits["status"]>(["allowed", "allowed_warning", "rejected"]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** a window as the SDK writes it: the fraction used and a unix time in seconds */
function window(v: unknown): LimitWindow | undefined {
  const w = v as Record<string, unknown> | null | undefined;
  if (!w || typeof w !== "object") return undefined;
  const used = num(w.utilization);
  const resetsAt = num(w.resetsAt);
  if (used === undefined || resetsAt === undefined) return undefined;
  return { used: Math.max(0, used), resetsAt: resetsAt * 1000 };
}

/** the plan figures on a usage update's meta, or null when the update carries none we can read */
export function parseRateLimit(meta: unknown, now: number): AgentLimits | null {
  const info = (meta as Record<string, unknown> | null | undefined)?.[RATE_LIMIT_META] as
    | Record<string, unknown>
    | undefined;
  if (!info || typeof info !== "object") return null;
  const status = info.status as AgentLimits["status"];
  if (!STATUSES.has(status)) return null;
  const binding = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
  const unified = (info.unifiedWindows ?? undefined) as Record<string, unknown> | undefined;
  const windows: AgentLimits["windows"] = {};
  const fiveHour = window(unified?.five_hour);
  const sevenDay = window(unified?.seven_day);
  if (fiveHour) windows.five_hour = fiveHour;
  if (sevenDay) windows.seven_day = sevenDay;
  // an older SDK sends the binding window's figures at the top level only; they are the same
  // numbers, so they fill that window in when the per-window object is missing
  if (!fiveHour && !sevenDay && (binding === "five_hour" || binding === "seven_day")) {
    const top = window({ utilization: info.utilization, resetsAt: info.resetsAt });
    if (top) windows[binding] = top;
  }
  if (!windows.five_hour && !windows.seven_day) return null;
  return { status, ...(binding ? { binding } : {}), windows, at: now };
}
