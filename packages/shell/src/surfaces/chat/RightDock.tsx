import { useStore } from "../../state/context.tsx";
import { useActive } from "../../state/selectors.ts";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";

/** the chat panel: transcript above, composer below */
export function RightDock({ width }: { width: number }) {
  const rightOpen = useStore((s) => s.rightOpen);
  const active = useActive();
  return (
    <div className={`right-dock ${rightOpen ? "" : "collapsed"}`} style={{ width }}>
      <ChatLog active={active} />
      <Composer active={active} />
    </div>
  );
}
