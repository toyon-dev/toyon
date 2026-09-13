import { editorItems, openedOnDaemonMachine } from "../../state/actions/editor.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu } from "../../ui/menu.ts";

/** the "open in" editor menu for the file in the editor pane; absent when the page was opened from
 * another device, where none of its rows can reach an editor */
export function OpenInMenu({ absPath, onReveal }: { absPath: string; onReveal?: () => void }) {
  const cm = useContextMenu("editor");
  if (!openedOnDaemonMachine(location.hostname)) return null;
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
