import { type OwnedWorktree, type PickMeta, SHELL_TOOL } from "@toyon/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { isBusy, pickLabel } from "../util.ts";
import { ChatItemView, ToolRow } from "./ChatItemView.tsx";
import { groupTools } from "./group.ts";

/** the transcript for the active worktree: items, working indicator, waiting messages, jump-down pill */
export function ChatLog({ active }: { active: OwnedWorktree | null }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const id = active?.worktree.id ?? null;
  const items = useLocalField(id, "chat");
  const queue = useLocalField(id, "queue");
  const logRef = useRef<HTMLDivElement>(null);

  // pin to bottom while streaming; offer a jump-down pill when scrolled up
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else if (items.length > 0) {
      setShowJump(true);
    }
  }, [items]);
  useOnChange([id], () => {
    atBottomRef.current = true;
    setShowJump(false);
  });

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = atBottom;
    if (atBottom) setShowJump(false);
  };
  const jumpDown = () => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setShowJump(false);
  };

  // stable across renders so memoized rows don't re-render on every delta
  const onPickHover = useCallback(
    (p: PickMeta, entering: boolean) => {
      if (!id) return;
      if (entering) previewBus.post(id, { type: "highlight-selector", selector: p.selector, label: pickLabel(p) });
      else previewBus.post(id, { type: "highlight-clear" });
    },
    [id],
  );

  const busy = !!active && isBusy(active);
  const wt = active?.worktree;
  // one array per worktree: a fresh one on every render would defeat the rows' memo
  const roots = useMemo(() => [wt?.path, wt?.linkPath].filter((p): p is string => !!p), [wt?.path, wt?.linkPath]);
  // calls that did the same thing to the same file, back to back, are one row carrying a count
  const entries = useMemo(() => groupTools(items, roots), [items, roots]);
  // the newest call while the agent runs: that row shows its output, everything above it is a line
  const liveRow = active?.agent === "working" ? entries.findLastIndex((e) => "tools" in e) : -1;
  // a `!` command still going: its row spins, and this is where the stop for it lives
  const shellRunning = items.some((i) => i.kind === "tool" && i.name === SHELL_TOOL && !i.done);

  return (
    <div className="chat-wrap">
      <div className="chat-log" ref={logRef} onScroll={onScroll}>
        {entries.map((entry, i) =>
          "tools" in entry ? (
            <ToolRow key={entry.at} tools={entry.tools} live={i === liveRow} roots={roots} worktreeId={id} />
          ) : (
            <ChatItemView key={entry.at} item={entry.item} worktreeId={id} onPickHover={onPickHover} />
          ),
        )}
        {busy && active && (
          <div className="msg-thinking working-row">
            {active.agent === "waiting" ? "waiting for your answer…" : "working…"}
            <Button
              variant="outline"
              tone="danger"
              data-tip={`Stop the agent (context up to here is kept${queue.length ? "; queued messages dropped" : ""})`}
              onClick={() => sock?.send({ t: "stop-agent", worktreeId: active.worktree.id })}
            >
              <Icon name="stop" className="icon-inline" /> stop
            </Button>
          </div>
        )}
        {shellRunning && active && (
          <div className="msg-thinking working-row">
            running…
            <Button
              variant="outline"
              tone="danger"
              data-tip="Kill the command; what it printed so far stays"
              onClick={() => sock?.send({ t: "exec-stop", worktreeId: active.worktree.id })}
            >
              <Icon name="stop" className="icon-inline" /> stop
            </Button>
          </div>
        )}
        {/* only an agent that cannot take a message mid-turn leaves one waiting here. The rest go
            into the turn as they are sent, and read as an ordinary message in the place they landed. */}
        {id &&
          queue.map((text, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: the queue is strings in send order; position is the identity, and a removed entry closes the gap
              key={`q-${i}`}
              className="msg-user queued-msg"
            >
              <span className="queued-tag">queued</span>
              <span className="queued-text">{text}</span>
              <span className="queued-actions">
                <IconButton
                  icon="edit"
                  label="Edit: removes from queue, puts it back in the input"
                  onClick={() => {
                    sock?.send({ t: "unqueue", worktreeId: id, index: i });
                    dispatch({ a: "set-draft", id, text });
                  }}
                />
                <IconButton
                  icon="close"
                  label="Remove from queue"
                  onClick={() => sock?.send({ t: "unqueue", worktreeId: id, index: i })}
                />
              </span>
            </div>
          ))}
      </div>
      {showJump && (
        <button className="jump-down" onClick={jumpDown} data-tip="Jump to latest">
          <Icon name="caret" className="icon-inline" /> new messages
        </button>
      )}
    </div>
  );
}
