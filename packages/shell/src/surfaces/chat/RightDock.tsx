import { useStore } from "../../state/context.tsx";
import { useArchivedPage, useFirstRun } from "../../state/selectors.ts";
import { ChatPanel } from "./ChatPanel.tsx";

/** the chat in its dock beside the preview */
export function RightDock({ width }: { width: number }) {
  const rightOpen = useStore((s) => s.rightOpen);
  // hidden, not closed, on a first-run screen: the layout remembers nothing of it. The same on an
  // archived worktree's page: the chat here is the row's underneath, and the page is about one
  // whose chat is with the daemon until it comes back
  const firstRun = useFirstRun();
  const archivedPage = useArchivedPage() !== null;
  return (
    <ChatPanel
      placement="dock"
      className={!rightOpen || firstRun || archivedPage ? "collapsed" : undefined}
      width={width}
    />
  );
}
