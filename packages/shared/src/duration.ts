// A duration as a settings file writes it ("30m") and as a line reads it back ("30 minutes").
// One unit at a time: a ceiling on a test suite is a round number of minutes, and a syntax that
// took "1h30m" would need to be explained where the key is documented for the one person in a
// hundred who wants it.

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 60 * 60_000 };

/** the shortest ceiling that means anything: under this a command is killed before it has printed
 * its first line, which reads as toyon being broken rather than the command being slow */
export const MIN_DURATION_MS = 10_000;
/** a ceiling is a guard against something stuck, and a day is past the point of guarding */
export const MAX_DURATION_MS = 24 * 60 * 60_000;

/** "30m", "90s", "1.5h" in milliseconds, or null for anything else */
export function parseDuration(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smh])\s*$/.exec(text);
  if (!m) return null;
  const ms = Number(m[1]) * (UNIT_MS[m[2] ?? ""] ?? 0);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

/** the duration in words, for a sentence: "30 minutes", "90 seconds", "1 hour" */
export function describeDuration(ms: number): string {
  const [n, unit] = pick(ms);
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** the duration as a settings file would write it: "30m", "90s", "1h" */
export function shortDuration(ms: number): string {
  const [n, unit] = pick(ms);
  return `${n}${unit.charAt(0)}`;
}

/** the largest unit that divides the duration evenly, else the largest one under it */
function pick(ms: number): [number, "second" | "minute" | "hour"] {
  const h = ms / UNIT_MS.h!;
  if (h >= 1 && Number.isInteger(h)) return [h, "hour"];
  const m = ms / UNIT_MS.m!;
  if (m >= 1 && Number.isInteger(m)) return [m, "minute"];
  if (m >= 60) return [Math.round(m), "minute"];
  // a ceiling under a second is a test's; a sentence saying "0 seconds" would read as a bug
  return [Math.max(1, Math.round(ms / 1000)), "second"];
}
