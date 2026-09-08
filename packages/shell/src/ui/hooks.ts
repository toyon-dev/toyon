import { type RefObject, useEffect, useRef, useState } from "react";

/** The overlays only scrim the preview column, so a click on a dock or the rail wouldn't reach a
 * backdrop — dismiss on any mousedown outside the box instead. A button that toggles its own box
 * is exempt: closing here would let its click reopen what it meant to close. */
export function useDismissOutside(box: RefObject<HTMLElement | null>, onOutside: () => void) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(".keys-btn, .project-pill")) return;
      if (box.current && !box.current.contains(t as Node)) cb.current();
    };
    // a click in the preview iframe never reaches this document, but it does move focus into the
    // frame; an app switch blurs the window too, and leaves focus where it was
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      timer = setTimeout(() => {
        if (document.activeElement?.tagName === "IFRAME") cb.current();
      });
    };
    document.addEventListener("mousedown", h);
    window.addEventListener("blur", onBlur);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", h);
      window.removeEventListener("blur", onBlur);
    };
  }, [box]);
}

/** Focus on mount — a chord may arrive while the preview iframe or Monaco holds focus, and
 * autoFocus alone loses that race, so take it explicitly on the next frame too. */
export function useFocusOnMount<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
    const f = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(f);
  }, []);
  return ref;
}

/** useState backed by localStorage (per browser); `parse` validates/clamps what was stored */
export function usePersisted<T>(key: string, fallback: T, parse: (raw: string | null) => T | undefined) {
  const [value, setValue] = useState<T>(() => {
    try {
      return parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    } catch {}
  };
  return [value, set] as const;
}

/** Pointer-drag resize: returns an onPointerDown for the handle. `measure` maps the pointer to a
 * size; body gets `.resizing` and the handle `.active` while dragging. */
export function useDragResize(measure: (e: PointerEvent) => number | null, onSize: (n: number) => void) {
  return (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const handle = e.currentTarget;
    handle.classList.add("active");
    const move = (ev: PointerEvent) => {
      const n = measure(ev);
      if (n !== null) onSize(n);
    };
    const up = () => {
      document.body.classList.remove("resizing");
      handle.classList.remove("active");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

/** True only once `on` has held for `ms`, false the instant it drops. For states worth showing
 * when they persist and not worth a flash when they don't: the socket is down on first paint and
 * for a blink on every reconnect, and painting that immediately reads as the app still loading. */
export function useSettled(on: boolean, ms: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!on) {
      setSettled(false);
      return;
    }
    const t = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return settled;
}

/** window.innerWidth, live */
export function useWindowWidth(): number {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}
