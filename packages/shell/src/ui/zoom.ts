/** a point in the window, measured from the picture's resting centre */
export type Pt = { x: number; y: number };
/** where a picture stands: scaled `s` about its resting centre, then carried `x, y` px */
export type Zoom = { s: number; x: number; y: number };
/** what it is held within: the picture's own size as laid out, the window's, and how far in it
 * goes */
export type Bounds = { w: number; h: number; W: number; H: number; max: number };

export const REST: Zoom = { s: 1, x: 0, y: 0 };
/** a double tap goes in this far: enough to read what was small, not so far that the next tap
 * back is the only way on */
export const TAP_SCALE = 2.5;
/** a pinch held smaller than the window follows the fingers down to here, so the hand feels the
 * picture give; let go, it comes back to fit (`settled`) */
export const PINCH_MIN = 0.5;
/** a pinch always goes in at least this far, and further when the picture has the pixels */
const MAX_FLOOR = 4;

export const resting = (z: Zoom): boolean => z.s === 1 && z.x === 0 && z.y === 0;

/** How far in a picture goes: to its own pixels when it has more than the window shows, and
 * fourfold whatever it has, so a small one still enlarges. */
export function maxScale(natural: number, rendered: number): number {
  return Math.max(MAX_FLOOR, rendered > 0 ? natural / rendered : MAX_FLOOR);
}

/** The picture at scale `s`, placed so that what stood under `from` at `z` stands under `to`:
 * a pinch keeps the picture between the fingers, a tap or a wheel keeps it under the pointer. */
export function about(z: Zoom, s: number, from: Pt, to: Pt): Zoom {
  const qx = (from.x - z.x) / z.s;
  const qy = (from.y - z.y) / z.s;
  return { s, x: to.x - qx * s, y: to.y - qy * s };
}

/** Carried no further than its edge meeting the window's, so nothing is dragged out of reach;
 * smaller than the window along an axis, it is centred on it. */
export function clampTo(z: Zoom, b: Bounds): Zoom {
  return { s: z.s, x: within(z.x, (b.w * z.s - b.W) / 2), y: within(z.y, (b.h * z.s - b.H) / 2) };
}

/** `v` held to `r` either way; no room is 0 and not the -0 that clamping a negative leaves */
const within = (v: number, r: number): number => (r <= 0 ? 0 : Math.min(r, Math.max(-r, v)));

/** Where a let-go leaves it: held smaller than fit it comes back to rest, past the far end it
 * stops there, and either way it is over the window. */
export function settled(z: Zoom, b: Bounds): Zoom {
  const s = Math.min(b.max, Math.max(1, z.s));
  return s === 1 ? REST : clampTo({ ...z, s }, b);
}

/** A double tap at `p`: at rest, in by TAP_SCALE with what was tapped kept under the finger;
 * anywhere else, back to rest. */
export function tapZoom(z: Zoom, p: Pt, b: Bounds): Zoom {
  if (!resting(z)) return REST;
  return clampTo(about(z, Math.min(TAP_SCALE, b.max), p, p), b);
}
