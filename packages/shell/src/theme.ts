// Applies a Theme to the document: CSS tokens on :root, color-scheme, the PWA
// title-bar tint, and a localStorage copy so the next load paints the right
// colors before the daemon's hello arrives.

import type { Theme } from "@orchardist/shared";
import { contrastFg, gruvboxDarkSoft, themeToCssVars } from "@orchardist/shared";

const CACHE_KEY = "orch-theme";

export function cachedTheme(): Theme {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const t = JSON.parse(raw) as Theme;
      if (t?.colors && typeof t.colors.bg0 === "string") return t;
    }
  } catch {}
  return gruvboxDarkSoft;
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeToCssVars(theme))) root.style.setProperty(k, v);
  root.style.colorScheme = theme.kind;
  root.dataset.theme = theme.kind;
  // installed PWA (window-controls-overlay): the caption area takes this color
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme.colors.bg1);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(theme));
  } catch {}
}

/** what the bridge needs to paint its overlays in the shell's accent */
export function bridgeThemeMsg(theme: Theme): Record<string, unknown> {
  return { type: "theme", accent: theme.colors.orange, accentFg: contrastFg(theme.colors.orange) };
}

export function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

/** subscribe to OS appearance changes; returns the unsubscribe */
export function onPrefersDarkChange(cb: (dark: boolean) => void): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) return () => {};
  const h = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener("change", h);
  return () => mq.removeEventListener("change", h);
}
