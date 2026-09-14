import { useDispatch, useStore } from "../../state/context.tsx";
import { useActive, useActiveRepo, useDraft } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { DraftIntro } from "./DraftIntro.tsx";
import { chatPanel } from "./useIntake.ts";
import "./chat.css";

/** The chat: transcript above, composer below. On main, which has no chat, the transcript's place
 * holds the draft's intro, and the composer writes the draft. It sits in the dock beside the
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
  const dispatch = useDispatch();
  const active = useActive();
  const draft = useDraft();
  const repo = useActiveRepo();
  // a project toyon opened on the chat without asking says what it went by, where the conversation
  // starts, with the way to say otherwise; a confirmed one was answered by the person and needs no line
  const assumed = placement === "centre" && repo?.assumed ? repo : null;
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
      {draft ? (
        <DraftIntro draft={draft} main={active} />
      ) : (
        <ChatLog
          active={active}
          lead={
            assumed && (
              <p className="hint chat-centre-note">
                {assumed.name} has <code>{assumed.assumed}</code> and no dev server, so it is chat only for now.{" "}
                <Button
                  variant="inline"
                  onClick={() => dispatch({ a: "open", overlay: { kind: "setup", repoId: assumed.id } })}
                >
                  add a dev server
                </Button>
              </p>
            )
          }
        />
      )}
      <Composer active={active} draft={draft} />
    </div>
  );
}
