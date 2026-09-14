import type { ArchivedWorktree } from "@toyon/shared";
import { useDispatch, useStore } from "../../state/context.tsx";
import { useActive, useActiveRepo, useDraft } from "../../state/selectors.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { ArchivedNote } from "./ArchivedNote.tsx";
import { ChatLog } from "./ChatLog.tsx";
import { Composer } from "./Composer.tsx";
import { DraftIntro } from "./DraftIntro.tsx";
import { chatPanel } from "./useIntake.ts";
import "./chat.css";

/** The chat: transcript above, composer below. On main, which has no chat, the transcript's place
 * holds the draft's intro, and the composer writes the draft. It sits in the dock beside the
 * preview, or is what the centre shows for a project with nothing to run, or for a removed
 * worktree (`archived`): its chat as it was, ending in the removal, over a box that brings it back.
 * Only one placement is ever mounted, so there is one composer to focus and one panel a dropped
 * file lands on. */
export function ChatPanel({
  placement,
  className,
  width,
  archived,
}: {
  placement: "dock" | "centre";
  className?: string;
  width?: number;
  archived?: ArchivedWorktree | null;
}) {
  const dispatch = useDispatch();
  // the row underneath an archived page is not what the page shows
  const active = useActive();
  const draft = useDraft();
  const repo = useActiveRepo();
  // a project toyon opened on the chat without asking says what it went by, where the conversation
  // starts, with the way to say otherwise; a confirmed one was answered by the person and needs no line
  const assumed = placement === "centre" && !archived && repo?.assumed ? repo : null;
  // dropped files attach here, but the drop is taken on the window (see useFileDrop): this only
  // lends it the panel's bounds and shows the highlight while the pointer is inside them
  const over = useStore((s) => s.dragFiles);
  return (
    <div
      className={cx(placement === "dock" ? "chat-dock" : "chat-centre", className, over && "drop-over")}
      style={width === undefined ? undefined : { width }}
      ref={(el) => {
        // the placement leaving must not clear the one arriving in the same commit
        if (el) chatPanel.el = el;
        else if (!chatPanel.el?.isConnected) chatPanel.el = null;
      }}
    >
      {archived ? (
        <ChatLog active={null} archived={archived} tail={<ArchivedNote item={archived} />} />
      ) : draft ? (
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
      {archived ? <Composer active={null} archived={archived} /> : <Composer active={active} draft={draft} />}
    </div>
  );
}
