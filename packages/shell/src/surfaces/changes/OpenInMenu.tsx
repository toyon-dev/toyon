import { useCallback, useState } from "react";
import { Icon } from "../../ui/Icon.tsx";
import { editorItems, Menu } from "../../ui/Menu.tsx";

/** the "open in" editor menu for the file in the diff pane */
export function OpenInMenu({ absPath, onReveal }: { absPath: string; onReveal?: () => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <button
        className="btn btn-outline deep-link"
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
      >
        open in <Icon name="caret" className="icon-inline" />
      </button>
      {anchor && <Menu anchor={anchor} align="right" onClose={close} items={editorItems(absPath, onReveal)} />}
    </>
  );
}
