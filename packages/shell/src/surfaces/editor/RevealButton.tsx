import { openedOnDaemonMachine } from "../../state/actions/editor.ts";
import { useUrls } from "../../state/context.tsx";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";

/** the way out of the editor pane to where the file sits on disk; absent when the page was opened
 * from another device, where the reveal would open on the daemon's screen and not this one */
export function RevealButton({ onReveal }: { onReveal: () => void }) {
  const { host } = useUrls();
  if (!openedOnDaemonMachine(host)) return null;
  return (
    <Button
      variant="outline"
      tone="quiet"
      mono
      className="deep-link"
      onClick={onReveal}
      data-tip="Reveal in Finder: show the file where it sits on disk"
    >
      <Icon name="folder" className="icon-inline" /> reveal
    </Button>
  );
}
