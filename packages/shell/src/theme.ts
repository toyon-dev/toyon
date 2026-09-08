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

/** subscribe to OS appearance changes; returns the unsubscribe */
export function onPrefersDarkChange(cb: (dark: boolean) => void): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) return () => {};
  const h = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener("change", h);
  return () => mq.removeEventListener("change", h);
}
