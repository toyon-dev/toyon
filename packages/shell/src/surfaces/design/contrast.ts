// WCAG contrast for a token swatch. A palette without ratios is decoration; the number is what
// tells you the "skip" tier is too dark to skip to, and it is the one thing about a color you
// cannot read off the color.

/** #rgb, #rrggbb and #rrggbbaa. Anything else (a var() chain, a named color, oklch) returns null
 * rather than a guess: only the running page can resolve those, and a wrong ratio is worse than
 * no ratio. */
export function parseHex(value: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (!m) return null;
  const h = m[1]!;
  const full = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join("") : h;
  if (full.length !== 6 && full.length !== 8) return null;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** relative luminance, per WCAG 2 */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * The token's contrast against the ground the pane is painted on, as "4.30:1".
 *
 * The ground is read off the live page rather than passed in, so the number tracks the theme the
 * shell is actually wearing: the same token is a different ratio in the dark half and the light
 * half, and a figure from the wrong half would quietly mislead.
 */
export function contrastRatio(value: string, ground?: string): string | null {
  const fg = parseHex(value);
  if (!fg) return null;
  const bgRaw = ground ?? readGround();
  const bg = bgRaw && parseHex(bgRaw);
  if (!bg) return null;
  const [a, b] = [luminance(fg), luminance(bg)];
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return `${ratio.toFixed(2)}:1`;
}

function readGround(): string | null {
  if (typeof document === "undefined") return null;
  const v = getComputedStyle(document.documentElement).getPropertyValue("--surface0").trim();
  if (v.startsWith("#")) return v;
  // computed styles come back as rgb() in every browser that did not get a hex literal
  const m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`;
}
