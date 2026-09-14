import { useStore } from "../../state/context.tsx";
import { useFirstRun } from "../../state/selectors.ts";
import { ChatPanel } from "./ChatPanel.tsx";

/** the chat in its dock beside the preview */
export function ChatDock({ width }: { width: number }) {
  const chatOpen = useStore((s) => s.chatOpen);
  // hidden, not closed, on a first-run screen: the layout remembers nothing of it
  const firstRun = useFirstRun();
  return <ChatPanel placement="dock" className={!chatOpen || firstRun ? "collapsed" : undefined} width={width} />;
}
