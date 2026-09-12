import { useStore } from "../../state/context.tsx";
import { useActive, useDraft, useFirstRun } from "../../state/selectors.ts";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { DraftIntro } from "./DraftIntro.tsx";
import { chatPanel } from "./useIntake.ts";
import "./chat.css";
import { cx } from "../../ui/cx.ts";

/** the chat panel: transcript above, composer below. While a worktree is being drafted the
 * transcript's place holds the draft's intro, and the composer writes the draft. */
export function RightDock({ width }: { width: number }) {
  const rightOpen = useStore((s) => s.rightOpen);
  // hidden, not closed, on a first-run screen: the layout remembers nothing of it
  const firstRun = useFirstRun();
  const active = useActive();
  const draft = useDraft();
  // dropped files attach here, but the drop is taken on the window (see useFileDrop): this only
  // lends it the panel's bounds and shows the highlight while the pointer is inside them
  const over = useStore((s) => s.dragFiles);
  return (
    <div
      className={cx("right-dock", (!rightOpen || firstRun) && "collapsed", over && "drop-over")}
      style={{ width }}
      ref={(el) => {
        chatPanel.el = el;
      }}
    >
      {draft ? <DraftIntro draft={draft} base={active} /> : <ChatLog active={active} />}
      <Composer active={active} draft={draft} />
    </div>
  );
}
