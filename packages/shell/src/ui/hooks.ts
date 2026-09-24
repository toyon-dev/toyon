import {
  type EffectCallback,
  type RefCallback,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Focus on mount — a chord may arrive while the preview iframe or Monaco holds focus, and
 * autoFocus alone loses that race, so take it explicitly on the next frame too. `select` also
 * selects an input's text, and only when focus is actually taken: selecting again on the next
 * frame would swallow a keystroke typed in between. `when` false takes nothing: on a touch screen
 * focusing a field raises the keyboard over half the window, and a list opened to be tapped
 * through should not open under one; a tap on the field asks for it. */
export function useFocusOnMount<T extends HTMLElement>(select = false, when = true): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!when) return;
    const take = () => {
      const el = ref.current;
      if (!el || document.activeElement === el) return;
      el.focus();
      if (select && el instanceof HTMLInputElement) el.select();
    };
    take();
    const f = requestAnimationFrame(take);
    return () => cancelAnimationFrame(f);
  }, [select, when]);
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

/** The last value that has held for `ms`; a new one takes over only once it has stayed that long,
 * and until then the one before it stands. For a line naming the stage of something that runs in
 * stages, most of them over before a name could be read: naming each as it starts flashes words
 * through the line, and holding a stage until its successor has proved slow keeps every word shown
 * one that was true for long enough to read. `undefined` takes over at once: nothing is not a name,
 * and the next run starts from nothing rather than from the last run's tail. */
export function useHeld<T>(value: T | undefined, ms: number): T | undefined {
  const [held, setHeld] = useState<T | undefined>(undefined);
  useEffect(() => {
    if (value === undefined) {
      setHeld(undefined);
      return;
    }
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}

/** how long a landing step runs before a shining line names it: a git call that is over inside
 * this is not a wait, and a name for it would be gone before it was read. One number for the
 * composer's line and the commit box's, so the two say the same step at the same moment. */
export const STEP_HOLD_MS = 1_500;

/** Whole seconds since `since` (a Date.now() stamp), ticking once a second while there is one; 0
 * while there is none. The stamp is the caller's and not this hook's, and it belongs in the store
 * against the thing it measures: a count that started when the component first saw it would start
 * over whenever the component is rebuilt, which the log and its rows are on every switch of
 * worktree. Nothing on the wire says when a call began, so a stamp taken when this tab heard of
 * it is the same undercount after a reload as for a call that began before the tab was open. */
export function useSecondsSince(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const on = since !== undefined;
  useEffect(() => {
    if (!on) return;
    // the last tick may be from an earlier count, so the first reading is taken fresh
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return on ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
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

/** how close to the end still counts as reading the end, so a pixel of rounding does not let go */
const TAIL_SLACK = 40;

/** A scroller that tails what it holds, the way a terminal does: the end stays in view while the
 * reader is at the end, and the moment they scroll up it stops following. Growth is watched in
 * the layout (the box, every child, and children as they come and go), not in state: a pin keyed
 * on data has to name every source of growth and misses the next. "At the end" is read from the
 * element when it scrolls, never from where a jump meant to land: a programmatic scroll dispatches
 * its event in the frame's scroll steps, before the observers deliver, so a reader taken elsewhere
 * is known to have left before anything could pull them back. `away` says `news` changed while
 * the reader was up the scroller; it is a value and not the layout because a row the reader opened
 * themselves grows the same way a message arriving does. `read` is for a caller that moved the
 * scroller itself and wants the answer now. The element is read when the effect mounts, so it
 * must be rendered from the first paint. */
export function useTail(
  ref: RefObject<HTMLElement | null>,
  news?: unknown,
): {
  away: boolean;
  pinned: () => boolean;
  jump: (smooth?: boolean) => void;
  read: () => void;
} {
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  useOnChange([news], () => {
    if (!pinned.current) setAway(true);
  });
  const read = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_SLACK;
    if (pinned.current) setAway(false);
  }, [ref]);
  const jump = useCallback(
    (smooth = false) => {
      const el = ref.current;
      if (!el) return;
      if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      else el.scrollTop = el.scrollHeight;
      pinned.current = true;
      setAway(false);
    },
    [ref],
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n instanceof Element) ro.observe(n);
        for (const n of r.removedNodes) if (n instanceof Element) ro.unobserve(n);
      }
    });
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", read);
      mo.disconnect();
      ro.disconnect();
    };
  }, [ref, read]);
  return { away, pinned: () => pinned.current, jump, read };
}

/** where a selection end sits inside `el`, as a count of the text before it */
function textOffsetIn(el: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** the text node and offset `at` characters into `el`, clamped to its end */
function textPointIn(el: HTMLElement, at: number): [Node, number] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    if (seen + t.data.length >= at) return [t, at - seen];
    seen += t.data.length;
    last = t;
  }
  return last ? [last, last.data.length] : [el, 0];
}

/** Keep `el.innerHTML` at `html`, carrying the selection across each swap. Replacing the markup
 * drops every node under `el`, and a selection end that sat in one collapses to a point before
 * them, so a drag through a message still streaming restarted from its first character with every
 * markdown tick, and a selection made in it vanished on the next. The ends inside `el` are held
 * as counts of the text before them and put back on the new nodes: a stream appends, so the text
 * before a point is the same text after the swap. React's own `dangerouslySetInnerHTML` gives no
 * turn between the old nodes going and the new ones landing, so the swap is done here. */
export function useLiveHtml(ref: RefObject<HTMLElement | null>, html: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sel = window.getSelection();
    const inside = (n: Node | null): n is Node => !!n && el.contains(n);
    const anchor =
      sel && sel.rangeCount > 0 && inside(sel.anchorNode) ? textOffsetIn(el, sel.anchorNode, sel.anchorOffset) : null;
    const focus =
      sel && sel.rangeCount > 0 && inside(sel.focusNode) ? textOffsetIn(el, sel.focusNode, sel.focusOffset) : null;
    const held =
      sel && (anchor !== null || focus !== null)
        ? ([sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] as const)
        : null;
    el.innerHTML = html;
    if (!sel || !held) return;
    const [a, ao] = anchor === null ? [held[0], held[1]] : textPointIn(el, anchor);
    const [f, fo] = focus === null ? [held[2], held[3]] : textPointIn(el, focus);
    if (a && f) sel.setBaseAndExtent(a, ao, f, fo);
  }, [ref, html]);
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
