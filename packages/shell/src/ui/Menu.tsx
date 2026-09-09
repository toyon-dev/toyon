import { type ReactNode, useEffect, useRef, useState } from "react";
import { step } from "./listNav.ts";

export type MenuItem = { label: ReactNode; onClick: () => void; danger?: boolean };

const WIDTH = 180;

/**
 * The context menu. Positioned at a point (right-click) or under an anchor's rect; clamped to the
 * viewport. Closes on any click, unhandled key, or window blur; the last one matters because clicks
 * inside the preview iframe never bubble here but do steal focus.
 *
 * Its rows are .row like every other list in the app, and it navigates like one: arrows move a
 * highlight, enter runs it, and hovering sets the same index so there is only ever one highlight.
 * Nothing is highlighted until a key arrives, so opening a menu with the mouse does not paint a
 * choice you have not made yet.
 */
export function Menu({
  at,
  anchor,
  align = "left",
  items,
  onClose,
}: {
  at?: { x: number; y: number };
  /** open under this element; `align` says which edge lines up */
  anchor?: DOMRect;
  align?: "left" | "right";
  items: MenuItem[];
  onClose: () => void;
}) {
  // -1 is "no row yet", which is why this is not 0: see the note above about opening with the mouse
  const [idx, setIdx] = useState(-1);
  // the listener is bound once, so what it reads has to be a ref: items are rebuilt every render
  const live = useRef({ idx, items });
  live.current = { idx, items };
  useEffect(() => {
    // the click that opened the menu is still bubbling when this mounts: ignore events older than us
    const openedAt = performance.now();
    const onClick = (e: MouseEvent) => {
      if (e.timeStamp > openedAt) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const { idx: i, items: its } = live.current;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        // from nothing, down takes the first row and up the last, so either key opens the list
        setIdx(i < 0 ? (d === 1 ? 0 : its.length - 1) : step(i, d, its.length));
        return;
      }
      if (e.key === "Enter" && i >= 0 && its[i]) {
        e.preventDefault();
        its[i].onClick();
        onClose();
        return;
      }
      // everything else, escape included, closes: a menu is not somewhere you type
      onClose();
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const x = anchor ? (align === "right" ? anchor.right - WIDTH : anchor.left) : (at?.x ?? 0);
  const y = anchor ? anchor.bottom + 4 : (at?.y ?? 0);
  const left = Math.max(4, Math.min(x, window.innerWidth - WIDTH - 4));
  // keep the whole menu on screen when opened near the bottom. The row height is a token, so it is
  // read off the root rather than written here twice: MonacoDiff and XTerm read --face-mono the
  // same way, for the same reason.
  const rowH = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row-h")) || 32;
  const top = Math.max(4, Math.min(y, window.innerHeight - items.length * rowH - 12));
  return (
    // the width is set here rather than in the stylesheet because the clamp above depends on it,
    // and a menu that is one width in CSS and another in the maths lands off screen at the edges
    <div className="menu" style={{ position: "fixed", left, top, width: WIDTH }}>
      {items.map((it, i) => (
        <button
          key={i}
          className={`row ${it.danger ? "danger" : ""} ${i === idx ? "active" : ""}`}
          // the pointer and the arrows drive one highlight, not two
          onMouseEnter={() => setIdx(i)}
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          <span className="menu-label">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

const EDITORS: Array<{ label: string; scheme: string }> = [
  { label: "Zed", scheme: "zed" },
  { label: "VS Code", scheme: "vscode" },
  { label: "Cursor", scheme: "cursor" },
];

/** the "open in <editor>" rows plus a Finder reveal, shared by the file menu and the diff header */
export function editorItems(absPath: string, onReveal?: () => void): MenuItem[] {
  const items: MenuItem[] = EDITORS.map((ed) => ({
    label: `open in ${ed.label}`,
    onClick: () => {
      window.location.href = `${ed.scheme}://file${absPath}`;
    },
  }));
  if (onReveal) items.push({ label: "reveal in Finder", onClick: onReveal });
  return items;
}
