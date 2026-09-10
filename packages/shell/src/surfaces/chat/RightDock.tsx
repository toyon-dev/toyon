import { useStore } from "../../state/context.tsx";
import { useActive, useGreenfield } from "../../state/selectors.ts";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { chatPanel } from "./useIntake.ts";
import "./chat.css";
import { cx } from "../../ui/cx.ts";

/** the chat panel: transcript above, composer below */
export function RightDock({ width }: { width: number }) {
  const rightOpen = useStore((s) => s.rightOpen);
  // hidden, not closed, while the composer is in the centre: the layout remembers nothing of it
  const greenfield = useGreenfield();
  const active = useActive();
  // dropped files attach here, but the drop is taken on the window (see useFileDrop): this only
  // lends it the panel's bounds and shows the highlight while the pointer is inside them
  const over = useStore((s) => s.dragFiles);
  return (
    <div
      className={cx("right-dock", (!rightOpen || greenfield) && "collapsed", over && "drop-over")}
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
