import { type ReactNode, useEffect } from "react";

export type MenuItem = { label: ReactNode; onClick: () => void; danger?: boolean };

const WIDTH = 180;

/**
 * The context menu. Positioned at a point (right-click) or under an anchor's rect; clamped to the
 * viewport. Closes on any click, key, or window blur — the last one matters because clicks inside
 * the preview iframe never bubble here but do steal focus.
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
  useEffect(() => {
    window.addEventListener("click", onClose);
    window.addEventListener("keydown", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("click", onClose);
      window.removeEventListener("keydown", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const x = anchor ? (align === "right" ? anchor.right - WIDTH : anchor.left) : (at?.x ?? 0);
  const y = anchor ? anchor.bottom + 4 : (at?.y ?? 0);
  const left = Math.max(4, Math.min(x, window.innerWidth - WIDTH - 4));
  return (
    <div className="ctx-menu" style={{ position: "fixed", left, top: y }}>
      {items.map((it, i) => (
        <button
          key={i}
          className={it.danger ? "danger" : undefined}
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          {it.label}
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
