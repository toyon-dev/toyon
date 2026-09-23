import { type ArchivedWorktree, type OwnedWorktree, type PickMeta, SHELL_TOOL } from "@toyon/shared";
import { useCallback, useMemo, useRef } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useDispatch, useSock, useStoreInstance } from "../../state/context.tsx";
import { useLocalField } from "../../state/selectors.ts";
import { localOf } from "../../state/store.ts";
import { IconButton } from "../../ui/Button.tsx";
import { useOnChange, useSecondsSince, useTail } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { useSelectAllWithin } from "../../ui/selectAll.ts";
import { isBusy, pickLabel } from "../util.ts";
import { openAsk } from "./ask.ts";
import { ChatItemView, QUIET_AFTER, ThoughtRow, ToolRow } from "./ChatItemView.tsx";
import { groupTools, indexOfSeq, openRow, ownCallRunning, runningRow, subagentsAtWork } from "./group.ts";
import { isBlank } from "./recall.ts";

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

  // the log tails the conversation: the newest line stays in view until the reader scrolls up,
  // and a pill offers the way back once something new is said. Another chat opens at its end.
  const follow = useTail(logRef, items);
  useOnChange([id], () => follow.jump());

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
    follow.read();
  };
  useOnChange([walkAt], () => {
    const el = logRef.current;
    if (!el) return;
    if (walkAt === undefined) {
      const start = walkStart.current;
      walkStart.current = null;
      if (!start || !isBlank(localOf(store.getState(), id).draft)) return;
      if (start.bottom) follow.jump();
      else {
        el.scrollTop = start.top;
        follow.read();
      }
      return;
    }
    walkStart.current ??= { bottom: follow.pinned(), top: el.scrollTop };
    scrollToMarked();
  });
  // A send goes to the end from wherever the reader was: the reply is what they are waiting for
  // now, and the message just sent is its only anchor. Pinning here, before the message lands,
  // is what keeps it in view once it does; the pill is for what arrives while they read, not this.
  // Declared after the walk's effect so that a walk ending in a send jumps rather than restores.
  const sent = useLocalField(id, "sent");
  useOnChange([sent], () => {
    if (sent) follow.jump();
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
  // while the thought is the newest thing in the log, and the thought stays open well past that.
  // A reply arriving is the same motion: the words landing say busy where the reader is looking,
  // so the row below stays out of it the way it does for a thought
  const last = entries.at(-1);
  const streaming =
    working && last && "item" in last && (last.item.kind === "thinking" || last.item.kind === "assistant")
      ? entries.length - 1
      : -1;
  // the newest `!` command is the one whose output is open; each one closes the one before it
  const newestShell = entries.findLastIndex((e) => "tools" in e && e.tools[0]?.name === SHELL_TOOL);
  // a `!` command still going: its row spins, and this is where the stop for it lives
  const shellRunning = items.some((i) => i.kind === "tool" && i.name === SHELL_TOOL && !i.done);
  // How long the log has been silent, in whole seconds. Between two calls nothing is in flight and
  // no row is live, and that gap is most of a turn; a mark that moves would say "busy" the same way
  // whether the agent is thinking or wedged, and this is the one signal that changes with the
  // difference: nothing while results keep landing, a number climbing when they stop. It measures
  // silence rather than the turn, so a running call counts too: a hung command is silence.
  // The stamp is the store's, not this component's: the log is one component showing whichever
  // worktree is active, so a stamp kept here would start over on every switch back. The render
  // that lands a result already sees the new stamp, so the count leaves in that render.
  const chatAt = useLocalField(id, "chatAt");
  const quiet = useSecondsSince(busy ? chatAt : undefined);
  // What in the log already says busy where the reader is looking: the shimmer on a running call
  // of the main agent's own, or a thought or reply still arriving. The word under the log would say it
  // again, so it shows only when nothing does, in the gap between two calls. A running call's
  // row carries its own count (ToolRow), so under it there is no line at all: "quiet" beside a
  // line that shines contradicted it, and one count below could not say which of two calls
  // running at once is the slow one. A stalled thought has no row to count on, so its silence is
  // still said here. A subagent's call does not count as moving: it runs under a spawn row that
  // closed when the spawn returned and has since been folded up the log, so its shimmer is one
  // nobody sees, and the word hiding for it would blink with every call the subagent makes. Nor
  // does the call that started a subagent and waits on it (ownCallRunning in group.ts): its row
  // is open with the subagent's rows under it, and the shine on its line is what the tailing log
  // scrolls off first.
  const calling = ownCallRunning(items);
  const moving = streaming >= 0 || calling;
  // the one row whose call is executing, which is the row that counts its wait: the rows behind
  // it in the batch shine for a call that has not started (runningRow in group.ts)
  const countingRow = useMemo(() => runningRow(entries), [entries]);
  // when that call reached the head of the batch, stamped by the store (the row is rebuilt on
  // every switch of worktree, so a clock of its own would start over)
  const running = useLocalField(id, "running");
  // the subagents the main agent is waiting on: named in the word, with their calls ticking beside
  // it, since their rows are out of sight and this line is the one place that can say so. The
  // spawn rows that started them shine for the same window.
  const fanout = useMemo(() => subagentsAtWork(items), [items]);
  const agents = fanout.ids.size;

  return (
    <div className="chat-wrap">
      <div className="chat-log" ref={logRef}>
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
              since={i === countingRow ? running?.at : undefined}
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
              streaming={working && i === entries.length - 1}
            />
          ),
        )}
        {/* the row is status alone: the stop is the composer's, in the field's corner, which stays
            put where this row scrolls off as soon as the log is read back. So while a call runs
            above, or a thought shimmers and the silence is short, there is no row: the shimmer
            says it, and the call's row counts its own wait. */}
        {busy &&
          active &&
          !(active.agent === "waiting" && askInBox) &&
          !calling &&
          !(moving && quiet < QUIET_AFTER) && (
            <div className="working-row">
              {/* waiting is not activity: it is blocked on you, and the rail keeps that dot steady
                for the same reason */}
              {active.agent === "waiting" ? (
                "waiting for your answer…"
              ) : moving ? (
                // the silence is the news, so it gets the word
                quiet >= QUIET_AFTER && (
                  <span>
                    quiet for<span className="working-num">{quiet}s</span>
                  </span>
                )
              ) : (
                <span className="working-mark">
                  {/* the mark and not a word: "working" said what the mark says, and the row is
                    read a hundred times a session. A word stays only where it adds a fact the
                    mark cannot: who is working, or where the wait is. */}
                  <Spinner variant="squares" />
                  {agents ? (
                    <>
                      <span className="working-word">
                        {agents} {agents === 1 ? "agent" : "agents"}
                      </span>
                      <span className="working-num">
                        {fanout.calls} {fanout.calls === 1 ? "call" : "calls"}
                      </span>
                    </>
                  ) : (
                    quiet >= QUIET_AFTER && (
                      <>
                        {/* with no call open and nothing streaming, a silence this long is the model
                          holding the turn: its thinking is summarized, and the summary lands only
                          once the thought is done, so a long think is a hole in the log. Naming it
                          says where the wait is. Under the threshold a healthy turn would flick
                          the number on and off with every result; past it, the silence is the news */}
                        <span className="working-word">thinking</span>
                        <span className="working-num">{quiet}s</span>
                      </>
                    )
                  )}
                </span>
              )}
            </div>
          )}
        {/* a `!` command's stop stays by its row: it kills the command, not the agent, and the
            composer's corner holds the agent's */}
        {shellRunning && active && (
          <div className="working-row">
            running…
            <IconButton
              icon="stop"
              tone="danger"
              label="Kill the command; what it printed so far stays"
              onClick={() => sock?.send({ t: "exec-stop", worktreeId: active.worktree.id })}
            />
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
      {follow.away && (
        <button className="jump-down" onClick={() => follow.jump(true)} data-tip="Jump to latest">
          <Icon name="caret" className="icon-inline" /> new messages
        </button>
      )}
    </div>
  );
}
