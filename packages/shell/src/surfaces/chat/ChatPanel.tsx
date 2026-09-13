import { useStore } from "../../state/context.tsx";
import { useActive, useDraft } from "../../state/selectors.ts";
import { cx } from "../../ui/cx.ts";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { DraftIntro } from "./DraftIntro.tsx";
import { chatPanel } from "./useIntake.ts";
import "./chat.css";

/** The chat: transcript above, composer below. While a worktree is being drafted the transcript's
 * place holds the draft's intro, and the composer writes the draft. It sits in the dock beside the
 * preview, or is what the centre shows for a project with nothing to run. Only one placement is
 * ever mounted, so there is one composer to focus and one panel a dropped file lands on. */
export function ChatPanel({
  placement,
  className,
  width,
}: {
  placement: "dock" | "centre";
  className?: string;
  width?: number;
}) {
  const active = useActive();
  const draft = useDraft();
  // dropped files attach here, but the drop is taken on the window (see useFileDrop): this only
  // lends it the panel's bounds and shows the highlight while the pointer is inside them
  const over = useStore((s) => s.dragFiles);
  return (
    <div
      className={cx(placement === "dock" ? "right-dock" : "chat-centre", className, over && "drop-over")}
      style={width === undefined ? undefined : { width }}
      ref={(el) => {
        // the placement leaving must not clear the one arriving in the same commit
        if (el) chatPanel.el = el;
        else if (!chatPanel.el?.isConnected) chatPanel.el = null;
      }}
    >
      {draft ? <DraftIntro draft={draft} base={active} /> : <ChatLog active={active} />}
      <Composer active={active} draft={draft} />
    </div>
  );
}
