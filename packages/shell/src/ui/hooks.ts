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

/** how long after the last scroll event the scroller still counts as moving: long enough that a
 * pause between two turns of the wheel does not blink a control that follows the motion, short
 * enough that it is gone before the reader has settled into reading */
const SCROLL_REST = 1200;

/** A scroller that tails what it holds, the way a terminal does: the end stays in view while the
 * reader is at the end, and the moment they scroll up it stops following. Growth is watched in
 * the layout (the box, every child, and children as they come and go), not in state: a pin keyed
 * on data has to name every source of growth and misses the next. "At the end" is read from the
 * element when it scrolls, never from where a jump meant to land: a programmatic scroll dispatches
 * its event in the frame's scroll steps, before the observers deliver, so a reader taken elsewhere
 * is known to have left before anything could pull them back. The one event not read that way is
 * the pin's own: it too arrives a frame late, and whatever landed in between (the message a send
 * jumped for) would measure as the reader having left, so an event that finds the scroller still
 * pinned and still where the pin put it changes nothing. A row taken out moves the scroller with
 * no resize to observe (the end came up to meet it), so the pin is taken again as the row leaves:
 * left for the event, a message landing in the same gap would be measured as the reader's.
 * While pinned the scroller takes no scroll anchoring: the end is the pin's to keep, and the
 * browser's own adjustment is a move the pin did not make. A composer that shrinks clamps the
 * scroller up, the message landing under it gives the room back, and anchoring returns the
 * scroller to where it was, short of the message; the event for that reads as the reader leaving.
 * `offEnd` and `offStart` say the reader is away from either end now, by the same slack, for a
 * control at each end that offers the rest of the way; `away` says `news` changed while they were
 * off the end, and it is a value and not the layout because a row the reader opened themselves
 * grows the same way a message arriving does. `moving` is the way the reader is pushing the scroller, by wheel or finger, and
 * null once they have rested: a control that follows the motion, the way a phone's address bar
 * does, shows for the direction they are already going and hides when they settle to read. A
 * scroll the layout or a jump caused is not motion; a scrollbar drag is missed, and a person
 * dragging the bar has the whole log under their hand already. `read` is for a caller that
 * moved the scroller itself and wants the answer now. The element is read when the effect mounts,
 * so it must be rendered from the first paint. */
export function useTail(
  ref: RefObject<HTMLElement | null>,
  news?: unknown,
): {
  offEnd: boolean;
  offStart: boolean;
  away: boolean;
  moving: "up" | "down" | null;
  pinned: () => boolean;
  jump: () => void;
  start: () => void;
  read: () => void;
} {
  const pinned = useRef(true);
  // where the pin last put the scroller, as the element reported it back
  const held = useRef<number | null>(null);
  const [offEnd, setOffEnd] = useState(false);
  const [offStart, setOffStart] = useState(false);
  const [away, setAway] = useState(false);
  const [moving, setMoving] = useState<"up" | "down" | null>(null);
  const hold = useCallback(
    (at: boolean) => {
      pinned.current = at;
      if (ref.current) ref.current.style.overflowAnchor = at ? "none" : "";
    },
    [ref],
  );
  const lastTouch = useRef<number | null>(null);
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  useOnChange([news], () => {
    if (!pinned.current) setAway(true);
  });
  const read = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    hold(el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_SLACK);
    setOffEnd(!pinned.current);
    setOffStart(el.scrollTop >= TAIL_SLACK);
    if (pinned.current) setAway(false);
  }, [ref, hold]);
  // Direction is read from the hand, not the scroll position: a row opening or closing moves the
  // log too (the browser anchors the position above it, a reveal scrolls its output into view,
  // the pin keeps the end in view as a reply streams), and none of that is the reader going
  // anywhere. A wheel's sign is the direction, and so is a finger's, inverted; a trackpad's
  // momentum keeps sending wheel events, so the caret rides the glide out.
  const push = useCallback((dy: number) => {
    if (dy === 0) return;
    setMoving(dy < 0 ? "up" : "down");
    if (rest.current) clearTimeout(rest.current);
    rest.current = setTimeout(() => setMoving(null), SCROLL_REST);
  }, []);
  // Both ends are reached in one step, the way End and Home reach them: across a long log a smooth
  // scroll takes a second of unreadable text going by, and the pin, which sets the end on every
  // resize, fights an animation still on its way there while a reply streams.
  const jump = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    held.current = el.scrollTop;
    hold(true);
    setOffEnd(false);
    setAway(false);
  }, [ref, hold]);
  // the scroll event keeps the rest current, so this only moves
  const start = useCallback(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    hold(pinned.current);
    const onScroll = () => {
      if (pinned.current && el.scrollTop === held.current) setOffStart(el.scrollTop >= TAIL_SLACK);
      else read();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const onWheel = (e: WheelEvent) => push(e.deltaY);
    const onTouchStart = (e: TouchEvent) => {
      lastTouch.current = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (y === undefined || lastTouch.current === null) return;
      push(lastTouch.current - y);
      lastTouch.current = y;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    const pin = () => {
      el.scrollTop = el.scrollHeight;
      held.current = el.scrollTop;
    };
    const ro = new ResizeObserver(() => {
      if (pinned.current) pin();
    });
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n instanceof Element) ro.observe(n);
        for (const n of r.removedNodes) if (n instanceof Element) ro.unobserve(n);
      }
      // only from the end: a scroller that a jump elsewhere has moved is the scroll event's to read
      if (pinned.current && el.scrollHeight - el.scrollTop - el.clientHeight < TAIL_SLACK) pin();
    });
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      mo.disconnect();
      ro.disconnect();
      if (rest.current) clearTimeout(rest.current);
    };
  }, [ref, read, push, hold]);
  return { offEnd, offStart, away, moving, pinned: () => pinned.current, jump, start, read };
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
      let { left, right } = b;
      // inside a box usePinToView has drawn smaller and moved: the edges as laid out, not as drawn
      const pin = el.closest<HTMLElement>("[data-pinned]");
      if (pin) {
        const p = pin.getBoundingClientRect();
        const k = pin.offsetWidth / p.width;
        left = pin.offsetLeft + (left - p.left) * k;
        right = pin.offsetLeft + (right - p.left) * k;
      }
      const next = { left: Math.round(left), right: Math.round(right) };
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

/** A trackpad pinch reaches the page as a wheel event with ctrl held, and the window only zooms
 * when nothing cancels it. A widget that scrolls itself in script (the editor, the terminal) takes
 * every wheel event and cancels it, pinch included, so the pinch is stopped on its way down to the
 * widget. For `onWheelCapture` on the box the widget mounts in. */
export function passPinch(e: { ctrlKey: boolean; stopPropagation: () => void }): void {
  if (e.ctrlKey) e.stopPropagation();
}

/** Holds a full-width strip at its own size on the top edge of a pinch-zoomed window. The pinch
 * magnifies the page under a view that pans over it, and nothing in CSS follows that view, so the
 * element is told where the view is and how far it is zoomed (`--pin-x`, `--pin-y`,
 * `--pin-scale`, with `data-pinned` while zoomed) and its stylesheet draws it there. The values go
 * on the element and not through state: they change on every frame of the gesture. */
export function usePinToView(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const view = window.visualViewport;
    if (!view) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      // a hair over 1 is rounding at the end of a pinch back out, not a zoom
      if (view.scale < 1.01) {
        delete el.dataset.pinned;
        return;
      }
      el.dataset.pinned = "";
      el.style.setProperty("--pin-x", `${view.offsetLeft}px`);
      el.style.setProperty("--pin-y", `${view.offsetTop}px`);
      el.style.setProperty("--pin-scale", String(1 / view.scale));
    };
    place();
    view.addEventListener("resize", place);
    view.addEventListener("scroll", place);
    return () => {
      view.removeEventListener("resize", place);
      view.removeEventListener("scroll", place);
    };
  }, [ref]);
}
