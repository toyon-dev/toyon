import { STREAM_TICK_MS } from "../../state/coalesce.ts";

/**
 * Streamed text is shown at a reading pace, a few characters a frame, rather than a tick at a time.
 *
 * Text reaches the store once a tick (coalesce.ts), and a tick's worth is about a line, so a row
 * that repaints on each delivery grows by a line at a time and reads as jumping. Each delivery is
 * instead spread over the time the next one is expected to take: the gap since the one before,
 * held between one tick and a few. Steady streaming then reads as a steady run of words, a slow
 * model reads as a slow one, and a burst after a pause (a reply after a tool call) is a quick wipe
 * rather than a wall, with nothing held back for longer than a few ticks.
 */

/** the longest a delivery is spread over: past this, pacing is text withheld, not text read */
export const PACE_SPAN_MAX_MS = 4 * STREAM_TICK_MS;

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
  const span = Math.min(Math.max(now - prev.at, STREAM_TICK_MS), PACE_SPAN_MAX_MS);
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
