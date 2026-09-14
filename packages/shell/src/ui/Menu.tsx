import { useEffect, useRef, useState } from "react";
import { useStoreInstance } from "../state/context.tsx";
import { Float } from "./Float.tsx";
import { jumpTo } from "./listNav.ts";
import "./menu.css";
import { cx } from "./cx.ts";
import { Icon } from "./Icon.tsx";
import { Kbd } from "./Kbd.tsx";
import { isItem, type MenuItem, type MenuSpec, menuPlacement, menuStore, stepEnabled, useMenu } from "./menu.ts";
import { rowState } from "./rowState.ts";

/** a modifier on its own: shift for a screenshot chord, cmd held while deciding. Not a key meant
 * for the menu or for anything behind it, so it neither moves the highlight nor closes anything. */
const MODIFIERS = new Set(["Shift", "Meta", "Control", "Alt", "CapsLock", "Fn"]);

/**
 * The one menu, mounted once at the root like Tooltips and drawn from the slot in menu.ts. A
 * portal to body, so the box sits in its own rung rather than in whichever surface opened it:
 * the rail's panel clips and stacks, a picker's overlay scrims, and a menu inside either was
 * under something.
 *
 * Everything that closes a menu is here, once: a pointerdown anywhere but the box (a right-click
 * on another row, or into the terminal, whose own menu must not open over ours; a left click on
 * the row the menu is about counts too, since the menu is about the row rather than opened by
 * it, and only a dropdown's own button is exempt so that its second press toggles), a click
 * outside the box, a chord, Escape, window blur (a click inside the preview iframe never reaches
 * this document but does steal focus), a scroll or a resize under a fixed box, and the target
 * leaving the DOM while its menu is up.
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
  // a menu about another row is another box, not this one moved: its highlight starts again and it
  // takes its own place among the floats
  return <Menu key={spec.id} spec={spec} />;
}

/**
 * Its rows are .row like every other list in the app, and it navigates like one: arrows move a
 * highlight, enter runs it, a letter jumps to the next row that starts with it, and hovering sets
 * the same index so there is only ever one highlight. Nothing is highlighted until a key arrives,
 * so opening a menu with the mouse does not paint a choice you have not made yet.
 */
function Menu({ spec }: { spec: MenuSpec }) {
  // the rows are what the keys walk; the rules between groups are drawn and never landed on
  const entries = spec.items;
  const items = entries.filter(isItem);
  // -1 is "no row yet", which is why this is not 0: see the note above about opening with the mouse
  const [idx, setIdx] = useState(-1);
  // the listeners are bound once per spec, so what they read has to be a ref
  const live = useRef({ idx, items });
  live.current = { idx, items };
  // typeahead reads the labels off the DOM, which is also what you see
  const box = useRef<HTMLDivElement | null>(null);
  // The keyboard, for as long as this is the topmost float. Arrows, Enter, Escape and typeahead end
  // here; anything else closes the menu and is let through, so the chord reaches the app behind it.
  const onKey = (e: KeyboardEvent) => {
    {
      const close = () => menuStore.close();
      const { idx: i, items: its } = live.current;
      if (MODIFIERS.has(e.key)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const d = e.key === "ArrowDown" ? 1 : -1;
        // from nothing, down takes the first row and up the last, so either key opens the list;
        // a disabled row is walked past, the way the OS menus do
        setIdx(stepEnabled(its, i, d));
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && i >= 0 && its[i] && !its[i].disabled) {
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
        if (j >= 0 && !its[j]?.disabled) setIdx(j);
        return;
      }
      // anything else (a chord, tab, a function key) closes the menu and is still let through, so
      // the chord reaches the app: hitting one is a way of saying you are done here
      close();
    }
  };
  useEffect(() => {
    const close = () => menuStore.close();
    // a scroll or a resize under a placed box leaves it over the wrong row; the box never scrolls
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, []);
  const { rect, placement } = menuPlacement(spec);
  // a list with a checked row in it reserves the gutter on every row, so the labels stay in a column
  const gutter = items.some((it) => it.checked);
  return (
    <Float
      className="menu"
      role="menu"
      boxRef={box}
      anchor={() => rect}
      placement={placement}
      track={false}
      // the row it is about places it in the stack; only a button that toggles it is also exempt
      // from its own press
      from={spec.target}
      trigger={spec.toggles ? spec.target : null}
      onDismiss={() => menuStore.close()}
      onKey={onKey}
      // a right-click on the menu itself is not a request for another one
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((e, n) => {
        // a rule between groups: it has no index in the rows, so the arrows walk straight past it
        // biome-ignore lint/suspicious/noArrayIndexKey: a rule has no identity but its place
        if (!isItem(e)) return <hr key={`sep-${n}`} className="menu-sep" />;
        const i = items.indexOf(e);
        return <MenuRow key={e.id} item={e} gutter={gutter} cursor={i === idx} onEnter={() => setIdx(i)} />;
      })}
    </Float>
  );
}

function MenuRow({
  item,
  gutter,
  cursor,
  onEnter,
}: {
  item: MenuItem;
  gutter: boolean;
  cursor: boolean;
  onEnter: () => void;
}) {
  const off = item.disabled !== undefined;
  // the reason a row is off is what its detail line says, unless it already says something
  const detail = item.detail ?? item.disabled;
  return (
    <button
      {...(item.checked === undefined
        ? { role: "menuitem" }
        : { role: "menuitemcheckbox", "aria-checked": item.checked })}
      aria-disabled={off || undefined}
      className={cx("row", item.danger && "danger", detail !== undefined && "row-tall", off && "disabled")}
      data-state={rowState({ cursor, checked: item.checked })}
      // the pointer and the arrows drive one highlight, not two; a row that is off takes neither
      onMouseEnter={off ? undefined : onEnter}
      onClick={() => {
        if (off) return;
        item.onClick();
        menuStore.close();
      }}
    >
      {gutter && <span className="menu-check">{item.checked && <Icon name="check" className="icon-inline" />}</span>}
      <span className="menu-text">
        <span className="menu-label">{item.label}</span>
        {detail !== undefined && <span className="menu-detail row-dim">{detail}</span>}
      </span>
      {/* the chord is a passenger on the row, not the verb: a tier down, lifting with the seat */}
      {item.key && <Kbd k={item.key} className="menu-key row-dim" />}
    </button>
  );
}
