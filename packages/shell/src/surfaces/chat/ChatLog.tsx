import { type ArchivedWorktree, type OwnedWorktree, type PickMeta, SHELL_TOOL } from "@toyon/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStoreInstance } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { localOf } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { useOnChange } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { useSelectAllWithin } from "../../ui/selectAll.ts";
import { isBusy, pickLabel } from "../util.ts";
import { openAsk } from "./ask.ts";
import { ChatItemView, ThoughtRow, ToolRow } from "./ChatItemView.tsx";
import { groupTools, indexOfSeq, openRow, subagentsAtWork } from "./group.ts";
import { isBlank } from "./recall.ts";

/** seconds of silence before the working line starts counting */
const QUIET_AFTER = 3;

/** Whole seconds since `items` last changed, ticking once a second while `busy`; 0 otherwise.
 * The stamp is taken in an effect keyed on `items`, so the render that lands a result still shows
 * the old count for up to a second; it forces a re-render only when a count was showing, so a
 * healthy turn streaming tokens pays nothing for this. */
function useQuietSeconds(items: unknown, busy: boolean): number {
  const since = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useOnChange([items], () => {
    const wasShowing = (now - since.current) / 1000 >= QUIET_AFTER;
    since.current = Date.now();
    if (wasShowing) setNow(since.current);
  });
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);
  return busy ? Math.floor((now - since.current) / 1000) : 0;
}

/** the transcript for the active worktree: items, working indicator, waiting messages, jump-down pill.
 * `lead` is a line the conversation starts from: the first child of the log, so it sits on the
 * composer in an empty chat and scrolls up as the conversation grows, the way a message would.
 * `tail` is the last thing said, after every message. A removed worktree's chat is `archived`
 * instead of `active`: the same log under the same id, with nothing running in it. */
export function ChatLog({
  active,
  archived,
  lead,
  tail,
}: {
  active: OwnedWorktree | null;
  archived?: ArchivedWorktree | null;
  lead?: React.ReactNode;
  tail?: React.ReactNode;
}) {
  const dispatch = useDispatch();
  const sock = useSock();
  const store = useStoreInstance();
  const id = active?.worktree.id ?? archived?.id ?? null;
  const items = useLocalField(id, "chat");
  const queue = useLocalField(id, "queue");
  const restoring = useLocalField(id, "restoring");
  const logRef = useRef<HTMLDivElement>(null);
  // a hand resting on the transcript: select-all is the conversation, not the shell around it
  useSelectAllWithin(logRef);

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
  // The composer is a sibling that grows: a recap line, the target sentence, a chip that wraps the
  // model row. Each one takes height off the log without a scroll event, so the newest row slides
  // under the box and nothing puts it back.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Read from the element rather than from where a scroll meant to land: a programmatic scroll has
  // to answer here before it paints, because the pinning above runs on the same frame and a stale
  // `true` would pull the log straight back to the bottom.
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
  const mark = useLocalField(id, "mark");
  const walkAt = mark?.by === "walk" ? mark.at : undefined;
  const walkStart = useRef<{ bottom: boolean; top: number } | null>(null);
  // the marked row to the top of the log, a walk's or a search hit's
  const scrollToMarked = () => {
    const el = logRef.current;
    const row = el?.querySelector<HTMLElement>(':scope > [data-state~="cursor"]');
    if (!el || !row) return;
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - pad;
    onScroll();
  };
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
    scrollToMarked();
  });
  // A hit picked in the chats palette marks its row the same way. The chat may still be on its way
  // (a worktree this tab had not opened, an archived page), so the row arriving scrolls to it as
  // well as the pick does; `n` scrolls again when the same hit is picked twice.
  const reveal = mark?.by === "reveal" ? mark : undefined;
  const revealAt = useMemo(() => (reveal ? indexOfSeq(items, reveal.seq) : -1), [items, reveal]);
  const markAt = walkAt ?? (revealAt >= 0 ? revealAt : undefined);
  useOnChange([reveal?.n, revealAt], () => {
    if (revealAt >= 0) scrollToMarked();
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
  // the ask in the box under the log, with the stop on its own floor: a row here saying the agent
  // waits, with a second stop, said what the box already says. Parked, the box is the plain one
  // again and the row is what says the turn is waiting on you.
  const askParked = useLocalField(id, "askParked");
  const askInBox = useMemo(() => {
    const ask = openAsk(items);
    return !!ask && askParked !== ask.id;
  }, [items, askParked]);
  const wt = active?.worktree;
  // one array per worktree: a fresh one on every render would defeat the rows' memo. An archived
  // chat's paths are under the directory it had, which is gone but is still what they are relative to
  const root = wt?.path ?? archived?.path;
  const roots = useMemo(() => (root ? [root] : []), [root]);
  // calls that did the same thing to the same file, back to back, are one row carrying a count,
  // and a subagent's calls are the run under the row that started it
  const entries = useMemo(() => groupTools(items, roots), [items, roots]);
  // the one row that opens itself while the agent runs; everything else in the turn is a line.
  // A turn stopped on a question is still the turn: the thought before the ask stays open while
  // the box waits, since it is the case the question is made from.
  const working = active?.agent === "working";
  const inTurn = working || active?.agent === "waiting";
  const liveRow = useMemo(() => (inTurn ? openRow(entries) : -1), [inTurn, entries]);
  // the live marks and the word are about now, not about what is open: the agent is thinking only
  // while the thought is the newest thing in the log, and the thought stays open well past that
  const last = entries.at(-1);
  const streaming = working && last && "item" in last && last.item.kind === "thinking" ? entries.length - 1 : -1;
  // the newest `!` command is the one whose output is open; each one closes the one before it
  const newestShell = entries.findLastIndex((e) => "tools" in e && e.tools[0]?.name === SHELL_TOOL);
  // a `!` command still going: its row spins, and this is where the stop for it lives
  const shellRunning = items.some((i) => i.kind === "tool" && i.name === SHELL_TOOL && !i.done);
  // How long the log has been silent, in whole seconds. Between two calls nothing is in flight and
  // no row is live, and that gap is most of a turn; a mark that moves would say "busy" the same way
  // whether the agent is thinking or wedged, and this is the one signal that changes with the
  // difference: nothing while results keep landing, a number climbing when they stop. It measures
  // silence rather than the turn, so a running call counts too: a hung command is silence.
  const quiet = useQuietSeconds(items, busy);
  // What in the log already says busy where the reader is looking: the shimmer on a running call
  // of the main agent's own, which is the newest row, or on a thought still arriving. The word
  // under the log would say it again, so it shows only when nothing does, in the gap between two
  // calls. A subagent's call does not count: it runs under a spawn row that closed when the spawn
  // returned and has since been folded up the log, so its shimmer is one nobody sees, and the word
  // hiding for it would blink with every call the subagent makes. The count stays either way: a
  // call that hangs shimmers like one that runs, and the seconds are what tell them apart.
  const moving = streaming >= 0 || items.some((i) => i.kind === "tool" && !i.done && !i.parentToolId);
  // the subagents the main agent is waiting on: named in the word, with their calls ticking beside
  // it, since their rows are out of sight and this line is the one place that can say so. The
  // spawn rows that started them shine for the same window.
  const fanout = useMemo(() => subagentsAtWork(items), [items]);
  const agents = fanout.ids.size;
  // The rows under the transcript land a frame after the message that caused them: the agent goes
  // busy after the send is in the log, a queued message after the daemon takes it. They add height
  // without touching `items`, so the send they follow scrolls out from under them.
  useOnChange([busy, active?.agent, shellRunning, queue.length], () => {
    const el = logRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="chat-wrap">
      <div className="chat-log" ref={logRef} onScroll={onScroll}>
        {lead}
        {entries.map((entry, i) =>
          "spawn" in entry ? (
            <ToolRow
              key={entry.at}
              tools={[entry.spawn]}
              run={entry.run}
              working={busy && fanout.ids.has(entry.spawn.id)}
              roots={roots}
              worktreeId={id}
            />
          ) : "tools" in entry ? (
            <ToolRow
              key={entry.at}
              tools={entry.tools}
              next={entry.next}
              live={i === liveRow || i === newestShell}
              roots={roots}
              worktreeId={id}
              // a `!` command is never grouped, so the walk's index is the row's own
              marked={entry.at === markAt}
            />
          ) : entry.item.kind === "thinking" ? (
            <ThoughtRow
              key={entry.at}
              item={entry.item}
              open={i === liveRow}
              streaming={i === streaming}
              worktreeId={id}
              fileRoot={active?.worktree.path}
            />
          ) : (
            <ChatItemView
              key={entry.at}
              item={entry.item}
              worktreeId={id}
              onPickHover={onPickHover}
              marked={entry.at === markAt}
            />
          ),
        )}
        {busy && active && !(active.agent === "waiting" && askInBox) && (
          <div className="working-row">
            {/* waiting is not activity: it is blocked on you, and the rail keeps that dot steady
                for the same reason */}
            {active.agent === "waiting" ? (
              "waiting for your answer…"
            ) : moving ? (
              // the silence is the news, so it gets the word; under the threshold the row is the
              // stop alone, since the shimmer above is saying the rest
              quiet >= QUIET_AFTER && (
                <span>
                  quiet for<span className="working-num">{quiet}s</span>
                </span>
              )
            ) : (
              <span>
                {agents ? `${agents} ${agents === 1 ? "agent" : "agents"} working…` : "working…"}
                {agents > 0 && (
                  <span className="working-num">
                    {fanout.calls} {fanout.calls === 1 ? "call" : "calls"}
                  </span>
                )}
                {/* under the threshold a healthy turn would flick the number on and off with
                    every result; past it, the silence is the news */}
                {quiet >= QUIET_AFTER && <span className="working-num">{quiet}s</span>}
              </span>
            )}
            <Button
              variant="outline"
              tone="danger"
              data-tip={`Stop the agent (context up to here is kept${queue.length ? "; queued messages go next" : ""})`}
              data-tip-key="esc"
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
        {tail}
        {/* sent from an archived page: newer than the archive it asks back from, so it reads under
            that note, and it stays until the restored agent has the message */}
        {restoring !== undefined && (
          <div className="msg-user queued-msg">
            <span className="queued-tag">restoring</span>
            <span className="queued-text">{restoring}</span>
          </div>
        )}
      </div>
      {showJump && (
        <button className="jump-down" onClick={jumpDown} data-tip="Jump to latest">
          <Icon name="caret" className="icon-inline" /> new messages
        </button>
      )}
    </div>
  );
}
