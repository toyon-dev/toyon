import { useStore } from "../../state/context.tsx";
import { useBare } from "../../state/selectors.ts";
import { ChatPanel } from "./ChatPanel.tsx";

/** the chat in its dock beside the preview */
export function ChatDock({ width }: { width: number }) {
  const chatOpen = useStore((s) => s.layout.chat);
  // hidden, not closed, on a first-run screen: the layout remembers nothing of it
  const bare = useBare();
  return <ChatPanel placement="dock" className={!chatOpen || bare ? "collapsed" : undefined} width={width} />;
}
