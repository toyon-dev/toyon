// Applies a Theme to the document: CSS tokens on :root, color-scheme, the PWA
// title-bar tint, and a localStorage copy so the next load paints the right
// colors before the daemon's hello arrives.

import type { ShellToBridgeMsg, Theme } from "@toyon/shared";
import { accentKey, contrastFg, themeToCssVars, toyonDark } from "@toyon/shared";
import { STORAGE } from "./state/keys.ts";

export function cachedTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE.theme);
    if (raw) {
      const t = JSON.parse(raw) as Theme;
      if (t?.colors && typeof t.colors.surface0 === "string") return t;
    }
  } catch {}
  return toyonDark;
}

export function applyTheme(theme: Theme, opts: { remember?: boolean } = {}) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeToCssVars(theme))) root.style.setProperty(k, v);
  root.style.colorScheme = theme.kind;
  root.dataset.theme = theme.kind;
  // installed PWA (window-controls-overlay): the caption area takes this color
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme.colors.surface1);
  if (opts.remember === false) return;
  try {
    localStorage.setItem(STORAGE.theme, JSON.stringify(theme));
  } catch {}
}

/** what the bridge needs to paint its overlays in the shell's accent */
export function bridgeThemeMsg(theme: Theme): ShellToBridgeMsg {
  const accent = theme.colors[accentKey(theme)];
  return { type: "theme", accent, accentFg: contrastFg(accent) };
}

export function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

/** how long after a boundary the cached answer can still be flipped and believed; past this, two
 * boundaries may have gone by and only the daemon knows which side we are on */
const STALE_MS = 12 * 3_600_000;

/**
 * The last thing the daemon said about the sun, carried forward. Opening the app in the morning
 * after closing it at night is the ordinary case, and the cached answer has expired by then: what
 * saves the flash is that we know it flipped at `until`, so one flip is still sound for a while.
 */
export function cachedDaylight(): { dark: boolean; until: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE.daylight);
    if (!raw) return null;
    const d = JSON.parse(raw) as { dark: boolean; until: number };
    if (typeof d?.dark !== "boolean" || typeof d.until !== "number") return null;
    const over = Date.now() - d.until;
    if (over < 0) return d;
    // flipped, but the boundary after it is the daemon's to know: `until` 0 says "ask, and until
    // the answer lands paint this rather than nothing"
    return over < STALE_MS ? { dark: !d.dark, until: 0 } : null;
  } catch {
    return null;
  }
}

export function rememberDaylight(d: { dark: boolean; until: number }) {
  try {
    localStorage.setItem(STORAGE.daylight, JSON.stringify(d));
  } catch {}
}

/** subscribe to OS appearance changes; returns the unsubscribe */
export function onPrefersDarkChange(cb: (dark: boolean) => void): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) return () => {};
  const h = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener("change", h);
  return () => mq.removeEventListener("change", h);
}
