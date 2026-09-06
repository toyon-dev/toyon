import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd.tsx";

/**
 * One tooltip for the whole app. Put `data-tip="…"` on any element (or spread
 * `tip("…", "⌘K")` on icon-only controls so they also get an accessible name;
 * `data-tip-key` / the second arg renders the shortcut set apart) and
 * mount `<Tooltips />` once at the root. Delegated: no wrappers, no per-element
 * state, works for elements rendered later. Shows on hover (after a short
 * delay) and on keyboard focus (immediately); hides on click, key, or scroll.
 */

export function tip(text: string, key?: string) {
  return { "data-tip": text, "data-tip-key": key, "aria-label": key ? `${text} (${key})` : text } as const;
}

const SHOW_DELAY = 120;
// after leaving a visible tooltip, the next one within this window shows
// instantly (sweeping a toolbar shouldn't re-wait on every button)
const WARM_MS = 600;
const GAP = 6;
const MARGIN = 8;

type Anchor = { el: HTMLElement; text: string; key?: string };

export function Tooltips() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    let current: HTMLElement | null = null;
    let visible = false;
    let lastHidden = 0;

    const clear = () => {
      window.clearTimeout(timer);
      if (visible) lastHidden = Date.now();
      visible = false;
      setAnchor(null);
    };
    const hide = () => {
      clear();
      current = null;
    };
    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text) return hide();
      visible = true;
      setAnchor({ el, text, key: el.dataset.tipKey });
    };
    const target = (e: Event) => {
      const t = e.target;
      return t instanceof Element ? (t.closest("[data-tip]") as HTMLElement | null) : null;
    };

    const onOver = (e: MouseEvent) => {
      const el = target(e);
      if (el === current) return;
      clear();
      current = el;
      if (!el) return;
      if (Date.now() - lastHidden < WARM_MS) return show(el);
      timer = window.setTimeout(() => show(el), SHOW_DELAY);
    };
    const onOut = (e: MouseEvent) => {
      // left the window entirely
      if (!e.relatedTarget) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = target(e);
      if (el?.matches(":focus-visible")) {
        window.clearTimeout(timer);
        current = el;
        show(el);
      }
    };
    const onBlur = () => hide();

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("mousedown", hide);
    document.addEventListener("keydown", hide);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("mousedown", hide);
      document.removeEventListener("keydown", hide);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // position after render so we can measure our own size; flip above when
  // there's no room below, clamp horizontally to the viewport
  useLayoutEffect(() => {
    const b = box.current;
    if (!b || !anchor) return;
    if (!anchor.el.isConnected) return setAnchor(null);
    const r = anchor.el.getBoundingClientRect();
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const above = r.bottom + GAP + h > vh - MARGIN && r.top - GAP - h >= MARGIN;
    const top = above ? r.top - GAP - h : r.bottom + GAP;
    const left = Math.min(Math.max(MARGIN, r.left + r.width / 2 - w / 2), vw - MARGIN - w);
    b.style.top = `${Math.round(top)}px`;
    b.style.left = `${Math.round(left)}px`;
    b.dataset.side = above ? "above" : "below";
  }, [anchor]);

  if (!anchor) return null;
  return createPortal(
    <div ref={box} className="tooltip" role="tooltip">
      {anchor.text}
      {anchor.key && <Kbd k={anchor.key} className="tooltip-key" />}
    </div>,
    document.body,
  );
}
