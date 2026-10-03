import {
  type ArchivedWorktree,
  type AttachmentInput,
  type AttachmentKind,
  nextNumbers,
  numbered,
  numbersAfter,
  type OwnedWorktree,
  type PickMeta,
  pasteSummary,
  SHELL_TOOL,
  type WorktreeStatus,
} from "@toyon/shared";
import { useCallback, useMemo, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { takeBackQueued } from "../../state/attach.ts";
import { useSock, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import { useLocalField } from "../../state/selectors.ts";
import { localOf } from "../../state/store.ts";
import { IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { DocumentFind } from "../../ui/DocumentFind.tsx";
import { isFind } from "../../ui/find.ts";
import { useOnChange, useSecondsSince, useTail } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { selectedText, useKeyWithin, useSelectAllWithin } from "../../ui/selectAll.ts";
import { uploadUrl } from "../../ws.ts";
import { elapsed, isBusy, pickLabel } from "../util.ts";
import { openAsk } from "./ask.ts";
import { ChatItemView, QUIET_AFTER, ThoughtRow, ToolRow } from "./ChatItemView.tsx";
import { FileChip } from "./FileChip.tsx";
import {
  groupTools,
  indexOfSeq,
  openRow,
  ownCallRunning,
  placeSpawns,
  queuedRows,
  runningRow,
  spawnsAtWork,
} from "./group.ts";
import { ImageChip } from "./ImageChip.tsx";
import { PasteChip } from "./PasteChip.tsx";
import { PickChip } from "./PickChip.tsx";
import { isBlank } from "./recall.ts";
import { chatPanel } from "./useIntake.ts";

/** the panel the log sits in, whichever placement mounted it: ⌘F from the composer under the log
 * means the conversation above it, as it does in Slack */
const panelRef = {
  get current() {
    return chatPanel.el;
  },
};

/** What a queued message carries, on its row: the chips it was sent with, numbered as they will be
 * when it goes, and nothing to take off, since the message is taken back whole. An image and a
 * file are read from where they were uploaded, which the message holds until it is recorded. */
function QueuedChips({
  items,
  next,
  worktreeId,
  dir,
  onOpen,
}: {
  items: readonly AttachmentInput[];
  next: Readonly<Record<AttachmentKind, number>>;
  worktreeId: string;
  dir: string | null;
  onOpen: (path: string, line: number) => void;
}) {
  return (
    <div className="msg-attachments">
      {numbered(items, next).map(([a, n]) =>
        a.kind === "image" ? (
          <ImageChip
            key={`image-${n}`}
            className="in-chat"
            src={uploadUrl(a.upload)}
            n={n}
            name={a.name}
            width={a.width}
            height={a.height}
            bytes={a.bytes}
          />
        ) : a.kind === "file" ? (
          <FileChip
            key={`file-${n}`}
            className="in-chat"
            name={a.name}
            bytes={a.bytes}
            href={a.text ? uploadUrl(a.upload) : undefined}
          />
        ) : a.kind === "paste" ? (
          <PasteChip
            key={`paste-${n}`}
            className="in-chat"
            n={n}
            name={a.name}
            source={a.source}
            {...pasteSummary(a.text)}
            text={a.text}
          />
        ) : (
          <PickChip key={`pick-${n}`} className="in-chat" pick={a} dir={dir} worktreeId={worktreeId} onOpen={onOpen} />
        ),
      )}
    </div>
  );
}

/** no spawn at work: one frozen set, so a turn that is over keys the same placement every render */
const NONE: ReadonlySet<string> = new Set();

/** the transcript for the active worktree: items, working indicator, waiting messages, jump-down pill.
 * `lead` is a line the conversation starts from: the first child of the log, so it sits on the
 * composer in an empty chat and scrolls up as the conversation grows, the way a message would.
 * `tail` is the last thing said, after every message. A removed worktree's chat is `archived`
 * instead of `active`: the same log under the same id, with nothing running in it. One toyon does
 * not run is `found`: an empty log under the row's id, holding what its box sends on the way. */
export function ChatLog({
  active,
  archived,
  found,
  lead,
  tail,
}: {
  active: OwnedWorktree | null;
  archived?: ArchivedWorktree | null;
  found?: WorktreeStatus | null;
  lead?: React.ReactNode;
  tail?: React.ReactNode;
}) {
  const sock = useSock();
  const store = useStoreInstance();
  const id = active?.worktree.id ?? archived?.id ?? found?.id ?? null;
  const items = useLocalField(id, "chat");
  const queue = useLocalField(id, "queue");
  const restoring = useLocalField(id, "restoring");
  const sending = useLocalField(id, "sending");
  // each queued message's chips count on from the sent ones and from the messages queued ahead of it
  const sentNumbers = useMemo(
    () => nextNumbers(items.map((c) => (c.kind === "user" ? c.attachments : undefined))),
    [items],
  );
  const queuedNumbers = useMemo(() => {
    let at = sentNumbers;
    return queue.map((q) => {
      const mine = at;
      at = numbersAfter(at, q.attachments ?? []);
      return mine;
    });
  }, [queue, sentNumbers]);
  // Every send passes through the daemon's queue on its way to the agent, for as long as the
  // session takes to open or a hold on the tree lasts. The bubble drawn at the press is that same
  // message, so its queued row would say it twice and lift the log by a row until it drained.
  const echoed = sending?.message ? queue.findIndex((q) => q.text === sending.message?.text) : -1;
  const logRef = useRef<HTMLDivElement>(null);
  // a hand resting on the transcript: select-all is the conversation, not the shell around it
  useSelectAllWithin(logRef);
  // and so is find: the browser's would read the rail and the panes with it, and count what is
  // not on screen. A selection in the log at the press is what is looked for. The box, once open,
  // answers ⌘F itself, so a press with the caret in it never reaches here. A hand on the chrome
  // (the rail, a dock, the bar) means the conversation as well: it is what is on screen to read.
  const [find, setFind] = useState<{ seed: string; seq: number } | null>(null);
  const openFind = useCallback(() => {
    const seed = (logRef.current && selectedText(logRef.current)) ?? "";
    setFind((f) => ({ seed: seed || f?.seed || "", seq: (f?.seq ?? 0) + 1 }));
  }, []);
  const fromChrome = useCallback(
    // a pane is a surface of its own: one that answers ⌘F took the key before it got here, and
    // the rest keep the browser's. So does an overlay, which holds the keyboard over the chat.
    (held: Element | null) => !held?.closest("[data-pane]") && !store.getState().overlay,
    [store],
  );
  useKeyWithin(panelRef, isFind, openFind, fromChrome);
  const closeFind = (current: Range | null) => {
    setFind(null);
    // the box goes, the match stays, as the reader's selection
    if (current) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(current);
    }
  };

  // the log tails the conversation: the newest line stays in view until the reader scrolls up.
  // While they scroll, one pill at the foot of the log offers the rest of the way in the direction
  // they are going, the start or the end, and fades when they settle to read. Something arriving
  // while they are up names itself on the pill and stays. Another chat opens at its end.
  const follow = useTail(logRef, items);
  useOnChange([id], () => follow.jump());
  const upSeg = follow.offStart && follow.moving === "up";
  const downSeg = follow.offEnd && (follow.moving === "down" || follow.away);
  const jump = (upSeg || downSeg) && (
    <div className={cx("jump", follow.away && "jump-news")}>
      {upSeg && (
        <button className="jump-up" onClick={follow.start} data-tip="Jump to start">
          <Icon name="caret-up" className="icon-inline" />
        </button>
      )}
      {downSeg && (
        <button className="jump-down" onClick={follow.jump} data-tip="Jump to latest">
          <Icon name="caret" className="icon-inline" />
          {follow.away && " new messages"}
        </button>
      )}
    </div>
  );

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
  // again and this row is the log's word that the turn is waiting on you.
  const askParked = useLocalField(id, "askParked");
  const askInBox = useMemo(() => {
    const ask = openAsk(items);
    return !!ask && askParked !== ask.id;
  }, [items, askParked]);
  const wt = active?.worktree;
  // one array per worktree: a fresh one on every render would defeat the rows' memo. An archived
  // chat's paths are under the directory it had, which is gone but is still what they are relative to
  const root = wt?.path ?? archived?.path ?? found?.path;
  const roots = useMemo(() => (root ? [root] : []), [root]);
  // calls that did the same thing to the same file, back to back, are one row carrying a count,
  // and a subagent's calls are the run under the row that started it
  const grouped = useMemo(() => groupTools(items, roots), [items, roots]);
  // A subagent at work is not in the transcript yet: its row floats at the foot of the log, under
  // everything the main agent has done since, shining with its count ticking, and joins the flow
  // where its work ended once it is done (placeSpawns in group.ts). Each floating row carries its
  // own count, on the subagent's call that is executing when the fold is open and on its own line
  // when closed, so a fan-out of three says which one is slow. Nothing floats once the turn is over:
  // a turn that ended on a subagent's call would otherwise hold its row at the foot for good.
  const atWork = useMemo(() => (busy ? spawnsAtWork(items) : NONE), [busy, items]);
  const { flow: entries, floating } = useMemo(() => placeSpawns(grouped, atWork), [grouped, atWork]);
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
  // A silence has two halves that read differently: the request sitting in the provider's queue,
  // and the model holding the turn with nothing to show. The agent's usage figure lands between
  // them, reported the moment the model starts replying and before any of the reply, so a figure
  // newer than the last item is the model's acknowledgement, and the count restarts there. The
  // figure is not labelled: the one closing the previous reply can land just after a fast call's
  // result and pass for the acknowledgement, and then the queue's wait is counted as the model's.
  // Rare, and the healthy case (acknowledged within a second or two) shows no word at all.
  const usage = useLocalField(id, "usage");
  const heardAt = usage?.heard !== undefined && chatAt !== undefined && usage.heard > chatAt ? usage.heard : undefined;
  const heard = useSecondsSince(busy ? heardAt : undefined);
  // What in the log already says busy where the reader is looking: the shimmer on a running call
  // of the main agent's own (ownCallRunning in group.ts says which calls count), a thought or
  // reply still arriving, or a spawn row floating at the foot. The word under the log shows only
  // when nothing does, in the gap between two calls. A running call's row carries its own count
  // (ToolRow), so under it there is no line at all: one count below could not say which of two
  // calls running at once is the slow one. A floating spawn row counts the same way, from the
  // log's stamp: a subagent's calls land in the log, so its silence is the log's, and the row that
  // says who is working is where the reader looks for how long (ToolRow hands the stamp on to the
  // subagent's executing call once the fold is open). A stalled thought has no row to count on,
  // so its silence alone is still said here.
  const calling = ownCallRunning(items);
  const fanned = floating.length > 0;
  const moving = streaming >= 0 || calling || fanned;
  // the one row whose call is executing, which is the row that counts its wait (runningRow in group.ts)
  const countingRow = useMemo(() => runningRow(entries), [entries]);
  // the rows written behind it that have not started, which hold still until they do
  const queued = useMemo(() => queuedRows(entries), [entries]);
  // when that call reached the head of the batch, stamped by the store (the row is rebuilt on
  // every switch of worktree, so a clock of its own would start over)
  const running = useLocalField(id, "running");

  return (
    <div className="chat-wrap">
      <div className="chat-log" ref={logRef}>
        {lead}
        {entries.map((entry, i) =>
          "spawn" in entry ? (
            <ToolRow key={entry.at} tools={[entry.spawn]} run={entry.run} roots={roots} worktreeId={id} />
          ) : "tools" in entry ? (
            <ToolRow
              key={entry.at}
              tools={entry.tools}
              next={entry.next}
              live={i === liveRow || i === newestShell}
              since={i === countingRow ? running?.at : undefined}
              queued={queued.has(i)}
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
        {/* the subagents at work and the commands running in the background, under everything
            that landed since they started: the same row, with the same key, so it keeps its fold
            and moves rather than remounts when it settles */}
        {floating.map((entry) =>
          "spawn" in entry ? (
            <ToolRow
              key={entry.at}
              tools={[entry.spawn]}
              run={entry.run}
              working
              since={chatAt}
              roots={roots}
              worktreeId={id}
            />
          ) : (
            <ToolRow key={entry.at} tools={entry.tools} since={chatAt} roots={roots} worktreeId={id} />
          ),
        )}
        {/* the row is status alone: the stop is the composer's, in the field's corner, which stays
            put where this row scrolls off as soon as the log is read back. So while a call runs
            above, a spawn row floats, or a thought shimmers and the silence is short, there is no
            row: the shimmer says it, and the call's or the spawn's row counts its own wait. */}
        {/* a message just sent, ahead of the agent's own copy of it: the bubble it will be, chips
            included, and under it the row below, which is one
            element from the press to the first reply so the mark never restarts */}
        {id && sending?.message && (
          <div className="msg-user">
            {sending.message.attachments && (
              <QueuedChips
                items={sending.message.attachments}
                next={sentNumbers}
                worktreeId={id}
                dir={active?.worktree.path ?? null}
                onOpen={(path, line) => openSource(store, sock, id, path, line)}
              />
            )}
            {/* plain words: a reference becomes a link when the sent row draws it, with the handlers
                that open it */}
            {sending.message.text}
          </div>
        )}
        {active &&
          (sending ||
            (busy &&
              !(active.agent === "waiting" && askInBox) &&
              !calling &&
              !fanned &&
              !(moving && quiet < QUIET_AFTER))) && (
            <div className="working-row">
              {/* waiting is not activity: it is blocked on you, and the rail keeps that dot steady
                for the same reason */}
              {active.agent === "waiting" ? (
                "waiting for your answer…"
              ) : moving ? (
                // the silence is the news, so it gets the word
                quiet >= QUIET_AFTER && (
                  <span>
                    quiet for<span className="working-num">{elapsed(quiet)}</span>
                  </span>
                )
              ) : (
                <span className="working-mark">
                  {/* the mark and not a word: "working" said what the mark says, and the row is
                    read a hundred times a session. A word stays only where it adds a fact the
                    mark cannot: who is working, or where the wait is. */}
                  <Spinner variant="squares" />
                  {heardAt !== undefined
                    ? // gated on its own count, not the whole silence: a short think after a long
                      // queue would otherwise flash a word for a wait that has just begun
                      heard >= QUIET_AFTER && (
                        <>
                          {/* with no call open and nothing streaming, a silence this long after the
                            model took the request is the model holding the turn: its thinking is
                            summarized, and the summary lands only once the thought is done, so a
                            long think is a hole in the log. Naming it says where the wait is. Under
                            the threshold a healthy turn would flick the number on and off with
                            every result; past it, the silence is the news */}
                          <span className="working-word">thinking</span>
                          <span className="working-num">{elapsed(heard)}</span>
                        </>
                      )
                    : quiet >= QUIET_AFTER && (
                        <>
                          {/* the model has not taken the request yet: the wait is the provider's
                            queue, not the agent's, and the word says so before it can read as the
                            model working hard */}
                          <span className="working-word">waiting for the model</span>
                          <span className="working-num">{elapsed(quiet)}</span>
                        </>
                      )}
                </span>
              )}
            </div>
          )}
        {/* only an agent that cannot take a message mid-turn leaves one waiting here. The rest go
            into the turn as they are sent, and read as an ordinary message in the place they landed. */}
        {id &&
          queue.map((message, i) =>
            i === echoed ? null : (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: the queue is messages in send order; position is the identity, and a removed entry closes the gap
                key={`q-${i}`}
                className="msg-user queued-msg"
              >
                <span className="queued-tag">
                  <Icon name="clock" className="icon-inline" />
                  queued
                </span>
                <div className="queued-text">
                  {message.attachments && (
                    <QueuedChips
                      items={message.attachments}
                      next={queuedNumbers[i] ?? sentNumbers}
                      worktreeId={id}
                      dir={active?.worktree.path ?? null}
                      onOpen={(path, line) => openSource(store, sock, id, path, line)}
                    />
                  )}
                  {message.text}
                </div>
                <span className="queued-actions">
                  <IconButton
                    icon="edit"
                    label="Edit: removes from queue, puts it back in the input"
                    onClick={() => takeBackQueued(store, sock, id, i)}
                  />
                  <IconButton
                    icon="close"
                    label="Remove from queue"
                    onClick={() => sock?.send({ t: "unqueue", worktreeId: id, index: i })}
                  />
                </span>
              </div>
            ),
          )}
        {tail}
        {/* sent from an archived page or a found worktree's: newer than the note it answers, so it
            reads under it, and it stays until the worktree's agent has the message */}
        {restoring !== undefined && (
          <div className="msg-user queued-msg">
            <span className="queued-tag">
              <Icon name="clock" className="icon-inline" />
              {found ? "taking over" : "restoring"}
            </span>
            <span className="queued-text">{restoring}</span>
          </div>
        )}
      </div>
      {find && <DocumentFind root={logRef} body={logRef} seed={find.seed} seq={find.seq} onClose={closeFind} />}
      {jump}
    </div>
  );
}
