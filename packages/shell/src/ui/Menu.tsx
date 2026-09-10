import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStoreInstance } from "../state/context.tsx";
import { jumpTo, step } from "./listNav.ts";
import "./menu.css";
import { cx } from "./cx.ts";
import { type MenuItem, type MenuSpec, menuBox, menuStore, useMenu } from "./menu.ts";
import { rowState } from "./rowState.ts";

const WIDTH = 180;

/** a modifier on its own: shift for a screenshot chord, cmd held while deciding. Not a key meant
 * for the menu or for anything behind it, so it neither moves the highlight nor closes anything. */
const MODIFIERS = new Set(["Shift", "Meta", "Control", "Alt", "CapsLock", "Fn"]);

/**
 * The one menu, mounted once at the root like Tooltips and drawn from the slot in menu.ts. A
 * portal to body, so the box sits in its own rung rather than in whichever surface opened it:
 * the rail's panel clips and stacks, a picker's overlay scrims, and a menu inside either was
 * under something.
 *
 * Everything that closes a menu is here, once: a pointerdown anywhere but the box and the thing
 * the menu is about (a right-click on another row, or into the terminal, whose own menu must
 * not open over ours), a click outside the box, a chord, Escape, window blur (a click inside the
 * preview iframe never reaches this document but does steal focus), a scroll or a resize under a
 * fixed box, and the target leaving the DOM while its menu is up.
 */
export function Menus() {
  const spec = useMenu();
  const store = useStoreInstance();
  // the row was removed while its menu was open (a remove from the palette, a snapshot that
  // dropped it): the DOM says so, and the store's tick is what makes React remove it
  useEffect(() => {
    if (!spec) return;
    const check = () => {
      if (!spec.target.isConnected) menuStore.close();
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    const unsub = store.subscribe(check);
    return () => {
      mo.disconnect();
      unsub();
    };
  }, [spec, store]);
  if (!spec) return null;
  return createPortal(<Menu spec={spec} />, document.body);
}

/**
 * Its rows are .row like every other list in the app, and it navigates like one: arrows move a
 * highlight, enter runs it, a letter jumps to the next row that starts with it, and hovering sets
 * the same index so there is only ever one highlight. Nothing is highlighted until a key arrives,
 * so opening a menu with the mouse does not paint a choice you have not made yet.
 */
function Menu({ spec }: { spec: MenuSpec }) {
  const { items } = spec;
  // -1 is "no row yet", which is why this is not 0: see the note above about opening with the mouse
  const [idx, setIdx] = useState(-1);
  // the listeners are bound once per spec, so what they read has to be a ref
  const live = useRef({ idx, items });
  live.current = { idx, items };
  // typeahead reads the labels off the DOM, which is also what you see
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = () => menuStore.close();
    const inside = (t: EventTarget | null) => t instanceof Node && box.current?.contains(t);
    // the click that opened the menu may still be bubbling when this mounts: ignore events older than us
    const openedAt = performance.now();
    const onClick = (e: MouseEvent) => {
      if (e.timeStamp > openedAt && !inside(e.target)) close();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (inside(e.target)) return;
      // on the trigger itself: a dropdown's second click toggles, and a row re-opening its own
      // menu at a new point is a replace, not a dismiss followed by nothing
      if (e.target instanceof Node && spec.target.contains(e.target)) return;
      close();
    };
    // Capture, because the menu is the topmost thing and the only one: app/keys.ts holds the
    // Escape ladder on a bubbling window keydown, and a focused listbox has its own arrows.
    // Taking the key first and ending it here is what "the topmost thing owns the key" means.
    const onKeyDown = (e: KeyboardEvent) => {
      const { idx: i, items: its } = live.current;
      if (MODIFIERS.has(e.key)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const d = e.key === "ArrowDown" ? 1 : -1;
        // from nothing, down takes the first row and up the last, so either key opens the list
        setIdx(i < 0 ? (d === 1 ? 0 : its.length - 1) : step(i, d, its.length));
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && i >= 0 && its[i]) {
        e.preventDefault();
        e.stopPropagation();
        its[i].onClick();
        close();
        return;
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      // a bare letter jumps to the next row starting with it, the way the OS menus do. One with no
      // match still ends here: with a menu up, a letter is a choice you are trying to make, not a
      // shortcut for the app behind it.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        const rows = Array.from(box.current?.querySelectorAll(".menu-label") ?? [], (b) => b.textContent ?? "");
        const j = jumpTo(rows, i, e.key);
        if (j >= 0) setIdx(j);
        return;
      }
      // anything else (a chord, tab, a function key) closes the menu and is still let through, so
      // the chord reaches the app: hitting one is a way of saying you are done here
      close();
    };
    // a scroll under a fixed box leaves it over the wrong row; the box itself never scrolls
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [spec]);
  // keep the whole menu on screen when opened near an edge. The row height is a token, so it is
  // read off the root rather than written here twice: MonacoDiff and XTerm read --face-mono the
  // same way, for the same reason.
  const rowH = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-height")) || 32;
  const { x: left, y: top } = menuBox(spec, WIDTH, items.length * rowH + 8, window.innerWidth, window.innerHeight);
  return (
    // the width is set here rather than in the stylesheet because the clamp above depends on it,
    // and a menu that is one width in CSS and another in the maths lands off screen at the edges
    <div
      className="menu"
      ref={box}
      style={{ position: "fixed", left, top, width: WIDTH }}
      // a right-click on the menu itself is not a request for another one
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (
        <MenuRow key={it.id} item={it} cursor={i === idx} onEnter={() => setIdx(i)} />
      ))}
    </div>
  );
}

function MenuRow({ item, cursor, onEnter }: { item: MenuItem; cursor: boolean; onEnter: () => void }) {
  return (
    <button
      className={cx("row", item.danger && "danger", item.detail !== undefined && "row-tall")}
      data-state={rowState({ cursor })}
      // the pointer and the arrows drive one highlight, not two
      onMouseEnter={onEnter}
      onClick={() => {
        item.onClick();
        menuStore.close();
      }}
    >
      <span className="menu-text">
        <span className="menu-label">{item.label}</span>
        {item.detail !== undefined && <span className="menu-detail row-dim">{item.detail}</span>}
      </span>
    </button>
  );
}
