import type { PickMeta, WorktreeStatus } from "@toyon/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { tip } from "../../ui/Tooltip.tsx";
import { pickLabel } from "../util.ts";
import { ChatItemView } from "./ChatItemView.tsx";

/** the transcript for the active worktree: items, working indicator, queued messages, jump-down pill */
export function ChatLog({ active }: { active: WorktreeStatus | null }) {
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
  useEffect(() => {
    atBottomRef.current = true;
    setShowJump(false);
  }, [id]);

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

  return (
    <div className="chat-wrap">
      <div className="chat-log" ref={logRef} onScroll={onScroll}>
        {items.map((item, i) => (
          <ChatItemView key={i} item={item} onPickHover={onPickHover} />
        ))}
        {active?.agent === "working" && (
          <div className="msg-thinking working-row">
            working…
            <button
              className="btn btn-outline stop-btn"
              data-tip="Stop the agent (context up to here is kept; queued messages dropped)"
              onClick={() => sock?.send({ t: "stop-agent", worktreeId: active.worktree.id })}
            >
              ■ stop
            </button>
          </div>
        )}
        {id &&
          queue.map((text, i) => (
            <div key={`q-${i}`} className="msg-user queued-msg">
              <span className="queued-tag">queued</span>
              <span className="queued-text">{text}</span>
              <span className="queued-actions">
                <button
                  {...tip("Edit — removes from queue, puts it back in the input")}
                  onClick={() => {
                    sock?.send({ t: "unqueue", worktreeId: id, index: i });
                    dispatch({ a: "set-draft", id, text });
                  }}
                >
                  ✎
                </button>
                <button
                  {...tip("Remove from queue")}
                  onClick={() => sock?.send({ t: "unqueue", worktreeId: id, index: i })}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
      </div>
      {showJump && (
        <button className="jump-down" onClick={jumpDown} data-tip="Jump to latest">
          ↓ new messages
        </button>
      )}
    </div>
  );
}
