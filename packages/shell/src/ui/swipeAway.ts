/** a finger has to travel this far before the touch is a drag, and which way it went by then decides
 * whose it is */
const SLOP = 8;
/** px per ms at the moment of letting go, over the last stretch of the drag: a throw, which takes
 * the thing away. Slower than that it is being put down, and it drops back where it was. */
const FLING = 0.7;
/** how much of the drag's tail the speed is read from: long enough to smooth the finger, short
 * enough that a drag that stopped and let go reads as stopped */
const TAIL_MS = 100;
/** the throw plays at the finger's own speed, within reason: the cap keeps a throw that was only
 * just one from drifting off */
const LEAVE_MIN_MS = 80;
const LEAVE_MAX_MS = 220;

/** how long a wheel may say nothing before its gesture is over: it has no letting go, and its
 * events come a frame apart from a trackpad and a notch apart from a mouse */
export const ROLL_IDLE_MS = 140;
/** as many samples as a tail can hold at a trackpad's rate */
const SAMPLES = 16;

export type Touch1 = { dx: number; dy: number };
export type Sample = { y: number; t: number };
/** a wheel gesture so far: how far it has carried the thing, and whose it turned out to be */
export type Roll = { dx: number; dy: number; axis: "away" | "other" | null; samples: Sample[] };
export const NO_ROLL: Roll = { dx: 0, dy: 0, axis: null, samples: [] };

/** What a touch that has travelled this far is: the swipe that takes the thing away, somebody
 * else's (the edge swipe back runs sideways), or nothing yet. */
export function swipeAxis({ dx, dy }: Touch1): "away" | "other" | null {
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return null;
  return Math.abs(dy) > Math.abs(dx) ? "away" : "other";
}

/** The finger's speed as it let go, px per ms, signed by direction: read over the tail of the
 * drag, so a finger that stopped and then lifted is going nowhere however far it came. */
export function releaseSpeed(samples: Sample[], now: number): number {
  const tail = samples.filter((s) => now - s.t <= TAIL_MS);
  const first = tail[0];
  const last = tail[tail.length - 1];
  if (!first || !last || last.t === first.t) return 0;
  return (last.y - first.y) / (last.t - first.t);
}

/** Whether a drag let go at this speed is a throw. */
export const flung = (speed: number): boolean => Math.abs(speed) >= FLING;

/**
 * A wheel event added to its gesture: two fingers on a trackpad, or a mouse wheel. The thing goes
 * the way the page under the fingers would, which is against the delta.
 *
 * A wheel never says it was let go, so the throw is called in flight: `thrown` is the speed, the
 * moment the travel reaches a throw's. Slower than that the thing follows, and the caller drops it
 * back once the wheel has been quiet for `ROLL_IDLE_MS`. A trackpad's momentum arrives as more of
 * the same events, so a drag let go slowly carries on a little and still drops back.
 */
export function rolled(r: Roll, e: { deltaX: number; deltaY: number }, now: number): { next: Roll; thrown: number } {
  const dx = r.dx - e.deltaX;
  const dy = r.dy - e.deltaY;
  const axis = r.axis ?? swipeAxis({ dx, dy });
  const samples = [...r.samples, { y: dy, t: now }].slice(-SAMPLES);
  const speed = axis === "away" ? releaseSpeed(samples, now) : 0;
  return { next: { dx, dy, axis, samples }, thrown: flung(speed) ? speed : 0 };
}

/** How long the throw takes to carry the thing the rest of the way off, at the speed it was let go. */
export function leaveMs(remaining: number, speed: number): number {
  return Math.min(LEAVE_MAX_MS, Math.max(LEAVE_MIN_MS, remaining / Math.abs(speed)));
}
