import { editorItems } from "../../state/actions/editor.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu } from "../../ui/menu.ts";

/** the "open in" editor menu for the file in the editor pane */
export function OpenInMenu({ absPath, onReveal }: { absPath: string; onReveal?: () => void }) {
  const cm = useContextMenu("editor");
  return (
    <Button
      variant="outline"
      tone="quiet"
      mono
      className="deep-link"
      {...cm.dropdown(() => editorItems(absPath, onReveal), "right")}
    >
      open in <Icon name="caret" className="icon-inline" />
    </Button>
  );
}
