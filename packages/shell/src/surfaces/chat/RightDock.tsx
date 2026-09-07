import { useStore } from "../../state/context.tsx";
import { useActive } from "../../state/selectors.ts";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { chatPanel } from "./useIntake.ts";

/** the chat panel: transcript above, composer below */
export function RightDock({ width }: { width: number }) {
  const rightOpen = useStore((s) => s.rightOpen);
  const active = useActive();
  // dropped files attach here, but the drop is taken on the window (see useFileDrop): this only
  // lends it the panel's bounds and shows the highlight while the pointer is inside them
  const over = useStore((s) => s.dragFiles);
  return (
    <div
      className={`right-dock ${rightOpen ? "" : "collapsed"} ${over ? "drop-over" : ""}`}
      style={{ width }}
      ref={(el) => {
        chatPanel.el = el;
      }}
    >
      <ChatLog active={active} />
      <Composer active={active} />
    </div>
  );
}
