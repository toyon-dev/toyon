import { useCallback, useState } from "react";
import { editorItems, Menu } from "../../ui/Menu.tsx";

/** "open in ▾" for the file in the diff pane */
export function OpenInMenu({ absPath, onReveal }: { absPath: string; onReveal?: () => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <button
        className="deep-link"
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
      >
        open in ▾
      </button>
      {anchor && <Menu anchor={anchor} align="right" onClose={close} items={editorItems(absPath, onReveal)} />}
    </>
  );
}
