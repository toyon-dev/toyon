import { STREAM_TICK_MS } from "../../state/coalesce.ts";

/**
 * Streamed text is shown at a reading pace, a few characters a frame, rather than a tick at a time.
 *
 * Text reaches the store once a tick (coalesce.ts), and a tick's worth is about a line, so a row
 * that repaints on each delivery grows by a line at a time and reads as jumping. Each delivery is
 * instead spread over a span: the gap since the one before, so steady streaming reads as a steady
 * run of words and a slow model reads as a slow one, or longer when what is waiting to be shown
 * would otherwise go by faster than writing. A reply that arrives whole (the newest models hand
 * over everything after a tool call in one burst, and the turn ends right behind it) is written
 * out at the writing rate, up to a ceiling past which it is a wipe: the text is there to be read,
 * and holding it back longer than that is withholding it.
 */

/** the fastest text is written out: about the rate the quicker models stream at */
export const PACE_CHARS_PER_S = 600;

/** the longest any backlog is spread over, whatever its size */
export const PACE_SPAN_MAX_MS = 4000;

/** one delivery of streamed text, spread from `at` over `span` ms */
export interface Pace {
  /** how much was shown when it arrived */
  from: number;
  /** how much there is now */
  to: number;
  at: number;
  span: number;
}

/** the pace for text now `length` long, carrying on from where the previous one had got to. The
 * first delivery shows at once: text already on screen when pacing begins, or a reply's first
 * words, are not wiped in. */
export function nextPace(prev: Pace | null, length: number, now: number): Pace {
  if (!prev) return { from: length, to: length, at: now, span: STREAM_TICK_MS };
  const from = Math.min(shownAt(prev, now), length);
  const byGap = now - prev.at;
  const byAmount = ((length - from) * 1000) / PACE_CHARS_PER_S;
  const span = Math.min(Math.max(byGap, byAmount, STREAM_TICK_MS), PACE_SPAN_MAX_MS);
  return { from, to: length, at: now, span };
}

/** how much of the text is shown at `now` */
export function shownAt(pace: Pace, now: number): number {
  const elapsed = now - pace.at;
  if (elapsed >= pace.span) return pace.to;
  return pace.from + Math.floor(((pace.to - pace.from) * Math.max(0, elapsed)) / pace.span);
}

/** the first `n` characters, never ending between the two halves of a surrogate pair */
export function cutAt(text: string, n: number): string {
  if (n >= text.length) return text;
  const code = text.charCodeAt(n);
  return text.slice(0, code >= 0xdc00 && code <= 0xdfff ? n + 1 : n);
}
