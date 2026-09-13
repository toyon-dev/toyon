import { useStore } from "../../state/context.tsx";
import { useFirstRun } from "../../state/selectors.ts";
import { ChatPanel } from "./ChatPanel.tsx";

/** the chat in its dock beside the preview */
export function RightDock({ width }: { width: number }) {
  const rightOpen = useStore((s) => s.rightOpen);
  // hidden, not closed, on a first-run screen: the layout remembers nothing of it
  const firstRun = useFirstRun();
  return <ChatPanel placement="dock" className={!rightOpen || firstRun ? "collapsed" : undefined} width={width} />;
}
