import { type OwnedWorktree, type PickMeta, SHELL_TOOL } from "@toyon/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStoreInstance } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { localOf } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { isBusy, pickLabel } from "../util.ts";
import { ChatItemView, ThoughtRow, ToolRow } from "./ChatItemView.tsx";
import { groupTools, railSlots } from "./group.ts";
import { isBlank } from "./recall.ts";

/** the transcript for the active worktree: items, working indicator, waiting messages, jump-down pill */
export function ChatLog({ active }: { active: OwnedWorktree | null }) {
  const dispatch = useDispatch();
  const sock = useSock();
  const store = useStoreInstance();
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

  // The composer's walk back through what was sent marks the row it is on and brings that row to
  // the top of the log, so what came after it is what fills the pane. A walk that ends in a blank box
  // (esc, a send, down past the newest) puts the log back where it began, pinned to the bottom if it
  // was; one that ends in an edit leaves the log on the message being edited.
  const walkAt = useLocalField(id, "walk")?.at;
  const walkStart = useRef<{ bottom: boolean; top: number } | null>(null);
  useOnChange([walkAt], () => {
    const el = logRef.current;
    if (!el) return;
    if (walkAt === undefined) {
      const start = walkStart.current;
      walkStart.current = null;
      if (!start || !isBlank(localOf(store.getState(), id).draft)) return;
      el.scrollTop = start.bottom ? el.scrollHeight : start.top;
      atBottomRef.current = start.bottom;
      if (start.bottom) setShowJump(false);
      return;
    }
    walkStart.current ??= { bottom: atBottomRef.current, top: el.scrollTop };
    const row = el.querySelector<HTMLElement>(':scope > [data-state~="cursor"]');
    if (!row) return;
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - pad;
  });

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
  // a colour per subagent, so two of them running at once are two runs and not one indented block
  const rails = useMemo(() => railSlots(items), [items]);
  // the newest call while the agent runs: that row shows its output, everything above it is a line
  const working = active?.agent === "working";
  const liveRow = working ? entries.findLastIndex((e) => "tools" in e) : -1;
  // a thought is live only while it is the newest thing in the log: the next call or word closes it
  const last = entries.at(-1);
  const liveThought = working && last && "item" in last && last.item.kind === "thinking" ? entries.length - 1 : -1;
  // the newest `!` command is the one whose output is open; each one closes the one before it
  const newestShell = entries.findLastIndex((e) => "tools" in e && e.tools[0]?.name === SHELL_TOOL);
  // a `!` command still going: its row spins, and this is where the stop for it lives
  const shellRunning = items.some((i) => i.kind === "tool" && i.name === SHELL_TOOL && !i.done);

  return (
    <div className="chat-wrap">
      <div className="chat-log" ref={logRef} onScroll={onScroll}>
        {entries.map((entry, i) =>
          "tools" in entry ? (
            <ToolRow
              key={entry.at}
              tools={entry.tools}
              live={i === liveRow || i === newestShell}
              roots={roots}
              worktreeId={id}
              rail={rails.get(entry.tools[0]?.parentToolId ?? "")}
              // a `!` command is never grouped, so the walk's index is the row's own
              marked={entry.at === walkAt}
            />
          ) : entry.item.kind === "thinking" ? (
            <ThoughtRow key={entry.at} item={entry.item} live={i === liveThought} />
          ) : (
            <ChatItemView
              key={entry.at}
              item={entry.item}
              worktreeId={id}
              onPickHover={onPickHover}
              marked={entry.at === walkAt}
            />
          ),
        )}
        {busy && active && (
          <div className="working-row">
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
          <div className="working-row">
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
