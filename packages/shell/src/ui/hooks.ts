import {
  type EffectCallback,
  type RefCallback,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Focus on mount — a chord may arrive while the preview iframe or Monaco holds focus, and
 * autoFocus alone loses that race, so take it explicitly on the next frame too. `select` also
 * selects an input's text, and only when focus is actually taken: selecting again on the next
 * frame would swallow a keystroke typed in between. */
export function useFocusOnMount<T extends HTMLElement>(select = false): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const take = () => {
      const el = ref.current;
      if (!el || document.activeElement === el) return;
      el.focus();
      if (select && el instanceof HTMLInputElement) el.select();
    };
    take();
    const f = requestAnimationFrame(take);
    return () => cancelAnimationFrame(f);
  }, [select]);
  return ref;
}

/** useState backed by localStorage (per browser); `parse` validates/clamps what was stored. The
 * value is held with its key, so a key that changes (the model remembered per agent, when the
 * draft's agent does) reads its own entry instead of keeping the last key's value. */
export function usePersisted<T>(key: string, fallback: T, parse: (raw: string | null) => T | undefined) {
  const read = (): T => {
    try {
      return parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [held, setHeld] = useState(() => ({ key, value: read() }));
  // state adjusted during render, React's pattern for state that follows a prop: the next render
  // holds the new key's entry, and this one reads it directly
  if (held.key !== key) setHeld({ key, value: read() });
  const value = held.key === key ? held.value : read();
  const set = (v: T) => {
    setHeld({ key, value: v });
    try {
      localStorage.setItem(key, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    } catch {}
  };
  return [value, set] as const;
}

/** Pointer-drag resize: returns an onPointerDown for the handle. `measure` maps the pointer (and
 * the handle, for a size taken from where its own box sits) to a size; body gets `.resizing` and
 * the handle `.active` while dragging. */
export function useDragResize(
  measure: (e: PointerEvent, handle: HTMLElement) => number | null,
  onSize: (n: number) => void,
) {
  return (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("active");
    const move = (ev: PointerEvent) => {
      const n = measure(ev, handle);
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

/** Scroll a row's output into view once it opens. A row grows wherever the layout has room: up
 * while the transcript is short enough to sit on the composer, down once it scrolls. Either way the
 * output can land below the pane, so after the open commits the scroller moves down far enough to
 * show it, and no further than the header reaching the top: the header is the one thing that must
 * stay on the page. Call `reveal(row)` in the handler, before the state change, with the element
 * that grows: it is measured after the open commits, so its rect is the header and the output. */
export function useReveal(scroller: string) {
  const armed = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = armed.current;
    if (!el) return;
    armed.current = null;
    const box = el.closest<HTMLElement>(scroller);
    if (!box) return;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const below = r.bottom - b.bottom;
    if (below <= 0) return;
    const pad = parseFloat(getComputedStyle(box).paddingTop) || 0;
    box.scrollTop += Math.min(below, Math.max(0, r.top - b.top - pad));
  });
  return (el: HTMLElement | null) => {
    armed.current = el;
  };
}

/** Run `fn` when `deps` change (and once on mount), reading whatever is current at that moment.
 * An effect keyed on the signal it answers, which the exhaustive-dependencies rule cannot express:
 * listing everything the body reads would run it on updates it does not answer to. The commit box
 * clears its draft when the worktree changes, not when that worktree's status ticks; the picker
 * reports its active row when the row's key changes, not when the parent rebuilds the results
 * array. The one exemption from that rule lives here, so a call site says `useOnChange([wt.id],
 * …)` and the rule holds everywhere else. `fn` may return a cleanup, as an effect's may. */
export function useOnChange(deps: readonly unknown[], fn: EffectCallback) {
  const latest = useRef(fn);
  latest.current = fn;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `deps` by design, see above
  useEffect(() => latest.current(), deps);
}

/** An element's left and right edges in the window, live: re-read when the element's size changes
 * and when the window's does, which between them cover a flex row's own moves. Rounded, and stored
 * only when they differ, so a resize that leaves them be re-renders nothing. The element comes in
 * as a value rather than a ref: a ref to a sibling's element is still empty while this component's
 * own layout effect runs, so it could not be observed from here. */
export function useEdgesOf(el: HTMLElement | null): { left: number; right: number } {
  const [edges, setEdges] = useState({ left: 0, right: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const b = el.getBoundingClientRect();
      const next = { left: Math.round(b.left), right: Math.round(b.right) };
      setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    window.addEventListener("resize", read);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [el]);
  return edges;
}

/** useEdgesOf for an element this component renders: put the callback on it as its `ref` */
export function useEdges<T extends HTMLElement>(): [RefCallback<T>, { left: number; right: number }] {
  const [el, setEl] = useState<T | null>(null);
  return [setEl, useEdgesOf(el)];
}
