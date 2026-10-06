import { LOGIN_STREAM, type PickMeta, SHELL_TOOL, type ShipOp, type ToolImage } from "@toyon/shared";
import { Fragment, memo, type ReactNode, useMemo, useRef, useState } from "react";
import { copyText } from "../../state/actions/deps.ts";
import { openFile } from "../../state/actions/file.ts";
import { type ChatLink, codeItems, imageItems, messageItems, pathItems } from "../../state/actions/message.ts";
import { archiveWorktrees } from "../../state/actions/worktree.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import { type ChatItem, worktreeById } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Field } from "../../ui/Field.tsx";
import { FullAttachment } from "../../ui/FullAttachment.tsx";
import { useLiveHtml, useOnChange, useReveal, useSecondsSince, useTail } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { grouped, type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { rowState } from "../../ui/rowState.ts";
import { Spinner } from "../../ui/Spinner.tsx";
import { treeKey } from "../../ui/treeNav.ts";
import { attachmentUrl } from "../../ws.ts";
import { elapsed, spanWords } from "../util.ts";
import { AskRow } from "./AskRow.tsx";
import { answeredQuestion, answerLines } from "./ask.ts";
import { chatLink, openChatLink } from "./chatLink.ts";
import { DaemonRow, useAgo } from "./DaemonRow.tsx";
import { FileChip } from "./FileChip.tsx";
import {
  queuedRows,
  runCalls,
  runningInRun,
  sameRun,
  sameTools,
  type ThinkingItem,
  type ToolEntry,
  type ToolItem,
} from "./group.ts";
import { SentImageChip } from "./ImageChip.tsx";
import { MentionText, openMention } from "./Mentions.tsx";
import { useMarkdown } from "./markdown.ts";
import { netOfCalls } from "./mergeDiffs.ts";
import { Painted } from "./Painted.tsx";
import { PasteChip } from "./PasteChip.tsx";
import { PickChip } from "./PickChip.tsx";
import { ranClean } from "./shellMode.ts";
import { languageOf, paintCode, paintDiff, pathInDiff } from "./syntax.ts";
import { normalizeThoughtMarkdown, thoughtLine, thoughtSteps } from "./thought.ts";
import {
  callPath,
  composing,
  diffLines,
  guardianHint,
  isGuardian,
  type OutputBlock,
  relPath,
  toolBlocks,
  toolLabel,
} from "./toolCall.ts";
import { toolRowItems } from "./toolRowItems.ts";
import { codeAt, useCodeCopy } from "./useCodeCopy.tsx";

function Markdown({
  text,
  menu,
  marked,
  worktreeId,
  fileRoot,
  streaming,
}: {
  text: string;
  /** the row's menu, told which link the pointer was on, if any, and the text of the fenced block
   * it was in, if any: the rendered markup is the row's, so nothing inside it has a handler of
   * its own */
  menu: (link: ChatLink | null, code: string | null) => MenuEntry[];
  marked?: boolean;
  worktreeId?: string | null;
  fileRoot?: string;
  streaming?: boolean;
}) {
  const html = useMarkdown(text, { fileRoot, streaming });
  const sock = useSock();
  const dispatch = useDispatch();
  const cm = useContextMenu("chat");
  // the DOMPurify-sanitized markup goes in through the hook, which keeps a selection through the
  // re-renders of a message still streaming
  const body = useRef<HTMLDivElement>(null);
  useLiveHtml(body, html);
  const refused = useStore((s) => (worktreeId ? s.local[worktreeId]?.refusedLink : undefined));
  // a link the daemon could not open is answered at the link: its underline turns, and the reason
  // takes the tip. The markup is the row's and is swapped whole on every render, so the mark is
  // put back after each swap (keyed on the html, which the body never reads); the tip it replaces
  // is kept on the element to be put back too.
  useOnChange([html, refused], () => {
    const el = body.current;
    if (!el) return;
    for (const a of el.querySelectorAll<HTMLAnchorElement>("a.file-link")) {
      const hit = refused !== undefined && a.getAttribute("href") === refused.href;
      a.classList.toggle("file-link-refused", hit);
      if (hit) {
        a.dataset.tipWas ??= a.dataset.tip ?? "";
        a.dataset.tip = refused.message;
        a.dataset.tipPlacement = "bottom";
        // the pointer is still on the link it pressed, and the press hid the tip: a fresh
        // mouseover brings it up again, now with the answer
        a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      } else if (a.dataset.tipWas !== undefined) {
        a.dataset.tip = a.dataset.tipWas;
        a.dataset.tipPlacement = "follow";
        delete a.dataset.tipWas;
      }
    }
  });
  // the markup goes into a child of the row so the row keeps a child of its own beside it
  const root = useRef<HTMLDivElement>(null);
  const codeCopy = useCodeCopy(root);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the links inside are the controls; the root only routes their clicks
    <div
      ref={root}
      className="msg-assistant md row-edge"
      data-state={rowState({ cursor: marked })}
      {...cm.contextMenu((_from, target) => menu(chatLink(target, fileRoot), codeAt(target)))}
      onClick={(e) => openChatLink(e, fileRoot, worktreeId, { sock, dispatch })}
    >
      <div ref={body} />
      {codeCopy}
    </div>
  );
}

/** how much of a diff the log prints before it hands off to the pane. A row is a receipt for what
 * the agent did, and a file written whole is hundreds of lines of it: past this the rest is a line
 * that opens the file's own diff, where reading it is what the surface is for. */
const DIFF_LINES = 40;

type PaintedBlock = ReturnType<typeof paintBlocks>[number];

/** splitting a diff into lines, its lines into words and its words into tokens is more work than a
 * render should redo, so every caller holds the result behind a memo */
function paintBlocks(blocks: OutputBlock[], path: string) {
  return blocks.map((b) => {
    // a read's output is a bare fence, so the file the call names is the only word on its language
    const language = languageOf(b.lang, path || (b.diff ? pathInDiff(b.text) : ""));
    if (b.diff) {
      const lines = diffLines(b.text);
      return { ...b, lines, painted: paintDiff(lines, language) };
    }
    return { ...b, lines: [], painted: b.code ? paintCode(b.text, language) : [] };
  });
}

/** the panel under a row: the agent's prose as prose, its fenced blocks as blocks, and a diff
 * coloured by line rather than printed as backticks. */
function ToolOut({ blocks, path, worktreeId }: { blocks: PaintedBlock[]; path: string; worktreeId?: string | null }) {
  const sock = useSock();
  const dispatch = useDispatch();
  return (
    <div className="tool-out">
      {blocks.map((b, i) =>
        b.diff ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and never reordered
          <pre key={i} className="tool-block diff">
            {b.lines.slice(0, DIFF_LINES).map((line, j) =>
              // a hunk header is a jump in the file, not a line of it: it draws as the rule between
              // two stretches of code, with the line numbers left on hover
              line.kind === "hunk" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: same
                <span key={j} className="dl hunk" title={line.text} />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: same
                <span key={j} className={`dl ${line.kind}`}>
                  {b.painted[j]?.length ? <Painted pieces={b.painted[j]} /> : line.text || " "}
                </span>
              ),
            )}
            {b.lines.length > DIFF_LINES && (
              <button
                type="button"
                className="dl more"
                disabled={!path || !worktreeId}
                data-tip={path && worktreeId ? "Open this file's diff" : undefined}
                onClick={() => worktreeId && openFile({ sock, dispatch }, { worktreeId, path, view: "diff" })}
              >
                {b.lines.length - DIFF_LINES} more lines
              </button>
            )}
          </pre>
        ) : b.code ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: same
          <pre key={i} className="tool-block">
            {b.painted.length
              ? b.painted.map((line, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: same
                  <Fragment key={j}>
                    {j > 0 ? "\n" : null}
                    <Painted pieces={line} />
                  </Fragment>
                ))
              : b.text}
          </pre>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: same
          <p key={i} className="tool-note">
            {b.text}
          </p>
        ),
      )}
    </div>
  );
}

/** a picture the call returned, at the band's width, where a read of a text file prints its lines.
 * It is the receipt for a read of a screenshot, which has nothing to say in words; a press opens it
 * at the window's size, as a sent image chip does. The file is the daemon's copy, so a picture the
 * agent took under /tmp is here whatever became of the original. */
function ToolPicture({ image, worktreeId }: { image: ToolImage; worktreeId: string }) {
  const src = attachmentUrl(worktreeId, image.file);
  const [full, setFull] = useState(false);
  const cm = useContextMenu("chat");
  return (
    <>
      <button
        type="button"
        className="tool-image"
        data-tip="Open full size"
        data-tip-placement="follow"
        onClick={() => setFull(true)}
        {...cm.contextMenu(() => imageItems(src, { open: () => setFull(true) }))}
      >
        <img src={src} alt={image.file} />
      </button>
      {full && (
        <FullAttachment owner="chat" onClose={() => setFull(false)} menu={() => imageItems(src)}>
          <img src={src} alt={image.file} />
        </FullAttachment>
      )}
    </>
  );
}

/** one call inside the row: what it ran, then what the agent wrote under it. A call with neither
 * draws nothing: output that is only whitespace, or only the description the summary line already
 * carries, parses to no blocks, and the panel they would have sat in was an empty bar under the
 * command. Memoized per call so a delta into the one in flight does not re-paint the ones above
 * it. */
const ToolPart = memo(function ToolPart({
  item,
  roots,
  worktreeId,
}: {
  item: ToolItem;
  roots?: string[];
  worktreeId?: string | null;
}) {
  const blocks = useMemo(() => paintBlocks(toolBlocks(item, item.output ?? ""), callPath(item)), [item]);
  const command = toolLabel(item, roots).command;
  const images = worktreeId ? (item.images ?? []) : [];
  if (!command && blocks.length === 0 && images.length === 0) return null;
  return (
    <div className="tool-part">
      {command && <pre className="tool-block cmd">{command}</pre>}
      {blocks.length > 0 && <ToolOut blocks={blocks} path={openable(item, roots)} worktreeId={worktreeId} />}
      {images.length > 0 && worktreeId && (
        <div className="tool-out">
          {images.map((img) => (
            <ToolPicture key={img.file} image={img} worktreeId={worktreeId} />
          ))}
        </div>
      )}
    </div>
  );
});

/** the file the call named, as the diff pane takes it. A call on something outside the worktree has
 * nothing for the pane to open, and says so by having no path. */
function openable(item: ToolItem, roots?: string[]): string {
  const rel = relPath(callPath(item), roots ?? []);
  return rel.startsWith("/") ? "" : rel;
}

/** a run of calls as the one change it came to */
const NetPart = memo(function NetPart({
  text,
  item,
  roots,
  worktreeId,
}: {
  text: string;
  item: ToolItem;
  roots?: string[];
  worktreeId?: string | null;
}) {
  const path = callPath(item);
  const blocks = useMemo(() => paintBlocks([{ code: true, diff: true, lang: "diff", text }], path), [text, path]);
  return (
    <div className="tool-part">
      <ToolOut blocks={blocks} path={openable(item, roots)} worktreeId={worktreeId} />
    </div>
  );
});

/** the band a line of the transcript folds out into: a call, a run of calls, a subagent's rows, or
 * a thought. `auto` is whether the row opens itself, which only the row the agent is on does, so
 * scrolling back over a long turn is a list of one-line rows; a click pins the row either way from
 * then on. A `leaf` has nothing under its line: a call that printed nothing and ran no command. It
 * stays a row, in the same column with the same glyph, but it is not a control: a click opened an
 * empty band with the accent edge down it, and a fill under the pointer promised the same.
 *
 * The band is the one box in the log with a height of its own: it stops at a share of the
 * transcript (chat.css, .tool-body) and scrolls inside, so whatever grows under a line while it is
 * watched (a thought, a process's output, a subagent's calls) leaves the line above it and the
 * composer under it on screen. The fold holds the cap rather than each body, so a new kind of body
 * is bounded without knowing it. */
function Fold({
  className,
  state,
  auto,
  leaf,
  growing,
  label,
  summary,
  menu,
  children,
}: {
  className: string;
  /** the row's data-state words (ui/rowState.ts) */
  state?: string;
  auto: boolean;
  leaf?: boolean;
  /** the body is still being written to. It tails inside its cap, the newest line in view until
   * the reader scrolls up, as the log does. A body at rest is read from the start instead: the
   * browser keeps a folded body's scroll, so without this a finished thought opened later would
   * open where the tail left it, on its last line. */
  growing?: boolean;
  label: string;
  summary: ReactNode;
  /** what a right-click on the row offers; told whether the row is open, and how to fold it, or
   * that there is nothing to fold, and the element under the pointer, for a body whose markup
   * holds things of its own (a fenced block in a thought) */
  menu: (fold: { open: boolean; leaf: boolean; toggle: () => void }, target: Element) => MenuEntry[];
  children: ReactNode;
}) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const card = useRef<HTMLDetailsElement>(null);
  // a body that is not open has no height and the pin is a no-op, so it costs nothing on the
  // closed rows of an old turn
  const body = useRef<HTMLDivElement>(null);
  const tail = useTail(body);
  // output that lands below the pane is scrolled into view once the row has opened. The hook is
  // handed the card, not the summary: the summary is the one part of the row that is already on
  // the page, and measuring it alone found nothing to reveal.
  const reveal = useReveal(".chat-log");
  // a leaf is closed whatever was pinned: a row pinned open while its call ran, that then printed
  // nothing, would otherwise hold an empty band
  const open = !leaf && (pinned ?? auto);
  const toggle = () => {
    if (leaf) return;
    if (!open) reveal(card.current);
    setPinned(!open);
  };
  const cm = useContextMenu("chat");
  return (
    <details
      ref={card}
      className={cx(className, leaf && "leaf")}
      data-state={state}
      open={open}
      onToggle={(e) => {
        if (!e.currentTarget.open || growing) return;
        const el = body.current;
        if (!el) return;
        el.scrollTop = 0;
        // the pin reads the box: at the top of a body taller than its cap it lets go, so the
        // resize the open itself causes does not pull the body back to its end
        tail.read();
      }}
      {...cm.contextMenu((_from, target) => menu({ open, leaf: !!leaf, toggle }, target))}
      // clicking the output selects text and leaves focus on the body, so the card takes it: that is
      // what makes Escape close the row you are reading, not only the one whose chip you clicked
      tabIndex={-1}
      onPointerDown={() => card.current?.focus({ preventScroll: true })}
      onKeyDown={(e) => {
        // ← closes the row that has focus and → opens it, as they do a folder in the files tree.
        // Unmodified only: with shift they extend a selection in the output.
        if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !leaf) {
          if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
          if (treeKey([{ depth: 0, open }], 0, e.key)) toggle();
          return;
        }
        // Escape belongs to the row that has focus. Anything less local (the terminal and diff
        // ladder in app/keys.ts) keeps the key otherwise, and a second press falls through to it.
        // A box open over the log took the key before it got here.
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        setPinned(false);
      }}
    >
      {/* controlled: let the click set `pinned` rather than the element toggling itself. A leaf's
          line is not a control, so it leaves the tab order too. */}
      <summary
        aria-label={label}
        tabIndex={leaf ? -1 : undefined}
        onClick={(e) => {
          e.preventDefault();
          toggle();
        }}
      >
        {summary}
      </summary>
      <div className="tool-body" ref={body}>
        {children}
      </div>
    </details>
  );
}

/** The agent's reasoning, folded like a call: it is addressed to nobody, and the message after it
 * says whatever in it mattered, so a paragraph of it in the flow reads as an answer that has lost
 * its colour. The line is one word rather than its first sentence, which is prose in a column of
 * file names. It is the one row that opens itself (openRow in group.ts). The body is markdown,
 * not a call's mono: it is prose.
 *
 * The word and its shine answer a narrower question than the fold does: a row still reading
 * "Thinking" over a call that has started says the wrong thing about where the agent is. */
export const ThoughtRow = memo(function ThoughtRow({
  item,
  open,
  streaming,
  worktreeId,
  fileRoot,
}: {
  item: ThinkingItem;
  /** the one row of the turn that opens itself */
  open?: boolean;
  /** the agent is thinking right now, rather than off doing what it decided */
  streaming?: boolean;
  worktreeId?: string | null;
  fileRoot?: string;
}) {
  // A thought written as a column of headlines (Codex, a summary part per step) is read by its
  // newest one, while it streams too: each arrives whole, so there is no first-words case, and
  // the line changing under the bulb is the agent moving on. The steps before it are the body,
  // so what it thought on the way is a click away and the column does not print one row per lid.
  // A single headline has no body, and its markup is "" rather than the line: the body's markup
  // goes in keyed on the string (useLiveHtml), and the first headline becoming the body when the
  // second lands is the string staying put while the body mounts.
  const steps = thoughtSteps(item.text);
  const earlier = steps.slice(0, -1);
  const html = useMarkdown(
    steps.length ? earlier.join("\n\n") : normalizeThoughtMarkdown(item.text),
    fileRoot ? { fileRoot } : undefined,
  );
  const sock = useSock();
  const dispatch = useDispatch();
  const word = streaming ? "Thinking" : "Thought";
  // the DOMPurify-sanitized markup goes in through the hook, which keeps a selection through the
  // re-renders of a thought still streaming
  const body = useRef<HTMLDivElement>(null);
  useLiveHtml(body, html);
  // the markup goes into a child of the band so the band keeps a child of its own beside it
  const root = useRef<HTMLDivElement>(null);
  const codeCopy = useCodeCopy(root);
  const out = (
    <div className="tool-part">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the links inside are the controls; the root only routes their clicks */}
      <div
        ref={root}
        className="tool-out thought-out md"
        onClick={(e) => openChatLink(e, fileRoot, worktreeId, { sock, dispatch })}
      >
        <div ref={body} />
        {codeCopy}
      </div>
    </div>
  );
  // a finished thought of one line is the line, printed where the word would go, with nothing
  // under it: a headline per step (Codex) folded into a card each was a column of lids
  const line = steps.at(-1) ?? (streaming ? "" : thoughtLine(item.text));
  if (line) {
    const leaf = earlier.length === 0;
    return (
      <Fold
        className="tool-row"
        auto={false}
        leaf={leaf}
        growing={streaming}
        label={line}
        menu={(fold, target) =>
          grouped([
            codeItems(codeAt(target)),
            [{ id: "copy", label: "copy thought", onClick: () => copyText(item.text) }],
            ...(leaf ? [] : [[{ id: "fold", label: fold.open ? "collapse" : "expand", onClick: fold.toggle }]]),
          ])
        }
        summary={
          <>
            <Icon name="bulb" className="tool-icon" />
            <span className={cx("tool-hint thought-line", streaming && "live-text")}>{line}</span>
          </>
        }
      >
        {leaf ? null : out}
      </Fold>
    );
  }
  return (
    <Fold
      className="tool-row"
      auto={!!open}
      growing={streaming}
      label={word}
      menu={(fold, target) =>
        grouped([
          codeItems(codeAt(target)),
          [{ id: "copy", label: "copy thought", onClick: () => copyText(item.text) }],
          [{ id: "fold", label: fold.open ? "collapse" : "expand", onClick: fold.toggle }],
        ])
      }
      summary={
        <>
          <Icon name="bulb" className="tool-icon" />
          <span className={cx("tool-name", streaming && "live-text")}>{word}</span>
        </>
      }
    >
      {out}
    </Fold>
  );
});

/** Seconds of silence before a count is put on it. Under this a healthy turn would flick a
 * number on and off with every result; past it, the silence is the news. One threshold for the
 * count on a running call's row and the word under the log, so the two never disagree about
 * whether a wait is long. */
export const QUIET_AFTER = 6;

/** the landing op a shell row's stop would end, as its label names it */
const SHIP_THE: Record<ShipOp, string> = {
  land: "the land",
  commit: "the commit",
  "sync-main": "the sync",
  "pull-main": "the pull",
};

/** a call in the transcript, or a run of calls that did the same thing to the same file, or the
 * call that started a subagent with that subagent's rows folded under it */
export const ToolRow = memo(
  function ToolRow({
    tools,
    run,
    next,
    live,
    working,
    since,
    queued,
    roots,
    worktreeId,
    marked,
  }: {
    tools: ToolItem[];
    /** the subagent this call started: its calls, as rows, which this row folds. Empty while it
     * has made none yet, or for an agent that marks a spawn but never tags a child (acp/map.ts). */
    run?: ToolEntry[];
    /** the call the agent is writing after this run, with no path yet: most likely this file
     * again (group.ts), so this row shines for it instead of a row of its own appearing below */
    next?: ToolItem;
    live?: boolean;
    /** the subagent this call started is still at work (spawnsAtWork in group.ts), and the row
     * floats at the foot of the log for it (placeSpawns). Its rows sit under a closed fold, so this
     * line's shine is what says so, and it holds across the gaps between the subagent's calls: a
     * shine that came and went with each call would restart its sweep every time and strobe
     * rather than travel. */
    working?: boolean;
    /** this row's call is the one executing (runningRow in group.ts), so its wait is counted
     * here, from this stamp: when the call reached the head of the batch, by the store's clock.
     * A floating spawn row is handed the log's last event instead (ChatLog): a subagent's calls
     * land in the log, so the seconds say how long nobody has been heard from. The row passes the
     * stamp down to the subagent's call that is executing (runningInRun), where the wait is, and
     * keeps it on its own line only while the fold is closed or no call under it is open. */
    since?: number;
    /** the call is written but has not started: it waits behind one that runs alone (queuedRows
     * in group.ts), so the row holds still until its turn */
    queued?: boolean;
    roots?: string[];
    worktreeId?: string | null;
    /** the composer has walked back to the command this row ran */
    marked?: boolean;
  }) {
    // every call in a run prints the same line, so the first one is the row
    const head = tools[0]!;
    // A run of calls on one file is read as the change the run came to, not as one diff per call
    // printing the same neighbourhood again (mergeDiffs.ts). No edit row opens itself any more, so
    // this is only ever read on a row somebody opened, and what they came for is what the run did.
    const net = useMemo(() => netOfCalls(tools.map((t) => toolBlocks(t, t.output ?? ""))), [tools]);
    const last = tools.at(-1) ?? head;
    const streaming = !last.done;
    // a `!` command whose shell has exited while something it started runs on: the row stays live
    // for that, and the word says why a row whose exit is in still shines
    const background = streaming && !!last.background;
    // the row is alive while its own last call runs, and while the agent writes the run's next
    // call: that one has no row until its path is in, and this row's shine is what says it is coming
    const alive = streaming || !!next;
    // A spawn row shines while its subagent works. A spawn run in the background returns at once,
    // so its own call says nothing about the subagent; the log says when it is at work.
    // A call queued behind another is open and not running, and its row says so by not moving: the
    // shine is the claim that something is happening on this line now.
    const running = (alive && !queued) || !!working;
    const waits = streaming && !!queued;
    // How long the call has been executing. The shine says busy the same way whether the call is
    // running or wedged; the count climbing beside it is what tells them apart, and only the
    // row at the head of the batch counts, from when it got there (runningRow in group.ts picks
    // it). The store keeps the stamp, since this row is rebuilt on every switch of worktree. A
    // background spawn's own call returned at once, so its row counts while it is at work instead.
    const age = useSecondsSince(streaming || working ? since : undefined);
    // A spawn row's seconds are the subagent's silence, and beside "42 calls" a bare number read
    // as the run's length. The wait belongs to the subagent's call that is executing, so that row
    // counts it, as the main agent's own running call does, and the spawn row's line keeps the
    // number only for a closed fold (chat.css hides it on an open one) or between calls, when
    // nothing under it is waiting and the silence is the subagent's own.
    const inner = run ? runningInRun(run) : -1;
    const waiting = useMemo(() => (run ? queuedRows(run, true) : undefined), [run]);
    // The log decides which row opens itself, and it hands the row two answers: the turn's one
    // self-opening row (openRow in group.ts, reasoning only) and the newest `!` command, which is
    // open from the start because what it printed is the reason the person ran it. A subagent's
    // row is not a third case: its calls are tool calls like the main agent's own, which fold to a
    // line, and the shine, the count ticking and the seconds beside it already say it is at work.
    // Open, it listed twenty reads nobody asked to read, and folded them all at once when the
    // subagent returned, under the words that say what came of it. A click pins it open for
    // whoever wants to watch.
    const auto = !!live;
    const text = toolLabel(head, roots);
    // the agent is still typing the call: the row says what it is typing, in the slot the path or
    // command will take, and the glyph alone names the kind, as on every row that has its detail
    const writing = streaming ? composing(head) : "";
    const { label, icon } = text;
    // a guardian review's line is its verdict, read off the report it printed (toolCall.ts)
    const guardian = isGuardian(head);
    const name = writing ? "" : guardian ? "Guardian" : text.name;
    // a spawn's description lands ahead of its brief (composing): it names the row meanwhile,
    // and the mark takes the count's slot, where the calls will tick once the subagent starts
    const briefed = writing && head.subagent ? text.hint : "";
    const hint = briefed || writing || (guardian ? guardianHint(head.output ?? "") : text.hint);
    // nothing under the line: no subagent rows, no net change, and no call that ran a command or
    // printed a block (ToolPart draws nothing for those). Read the same way ToolPart does, so the
    // row is a leaf exactly when opening it would show nothing.
    const leaf =
      !(run && run.length > 0) &&
      !net &&
      tools.every(
        (t) => !toolLabel(t, roots).command && toolBlocks(t, t.output ?? "").length === 0 && !t.images?.length,
      );
    const calls = run ? runCalls(run) : 0;
    const clean = ranClean(tools);
    const what =
      [label, hint].filter(Boolean).join(" ") +
      (background ? ", in the background" : "") +
      (waits ? ", queued" : "") +
      (clean ? ", done" : "");
    // no count while the call is still being written: a spawn's "0 calls" beside the mark read as
    // a subagent that had started and done nothing
    const count = writing
      ? ""
      : run
        ? `${calls} ${calls === 1 ? "call" : "calls"}`
        : tools.length > 1
          ? `×${tools.length}`
          : "";
    const store = useStoreInstance();
    const sock = useSock();
    // A `!` command's stop sits on its own row, since it kills the command and not the agent,
    // whose stop is the composer's corner. A landing's git steps run as the same rows, so the
    // press then ends the landing, and the label says which it is.
    const op = useStore((s) => (worktreeId ? s.shipping[worktreeId]?.op : undefined));
    const stoppable = streaming && head.name === SHELL_TOOL && worktreeId ? { worktreeId, toolId: last.id } : null;
    return (
      <Fold
        className={cx(
          "tool-row",
          tools.some((t) => t.isError) && "error",
          head.parentToolId && "nested",
          run && "spawn",
          waits && "queued",
        )}
        state={rowState({ cursor: marked })}
        auto={auto}
        leaf={leaf}
        growing={running}
        label={run && count ? `${what}, ${count}` : tools.length > 1 ? `${what}, ${tools.length} calls` : what}
        menu={(fold) => {
          const w = worktreeById(store.getState(), worktreeId);
          const wt = w ? { id: w.worktree.id, dir: w.worktree.path } : null;
          return toolRowItems(tools, roots ?? [], wt, { sock, dispatch: store.dispatch }, fold);
        }}
        summary={
          <>
            {/* the kind says "think", which is the nearest word ACP has for a call that starts
                another agent, and the bulb is a thought's glyph: this row is a fork, not a thought */}
            <Icon name={run ? "spawn" : icon} className="tool-icon" />
            {/* one shine to a line: each span sweeps on its own width, so a name and a hint both lit
                are two bands out of step. The hint is what the call is doing, so the name shines
                only where it is the whole line. */}
            {name && <span className={cx("tool-name", running && !hint && "live-text")}>{name}</span>}
            {/* while the input streams the hint slot holds the mark, and the phrase is its tip: on
                the line it was replaced by the command a beat later, two lines of text for one
                event, but an edit sits here for the whole replacement, and a mark alone for ten
                seconds read as a stalled tool, so the phrase is there for whoever comes to ask.
                It still names the row for the fold's label. */}
            {writing && !briefed ? (
              <span className="tool-writing" data-tip={hint}>
                <Spinner variant="squares" />
              </span>
            ) : (
              hint && <span className={cx("tool-hint", running && "live-text")}>{hint}</span>
            )}
            {background && <span className="tool-status">in the background</span>}
            {/* the row is faint and still (chat.css), and the word says what the faintness means */}
            {waits && <span className="tool-status">queued</span>}
            {/* the mark is drawn, so the fold's label carries the word for it */}
            {clean && <Icon name="check" className="tool-done" />}
            {age >= QUIET_AFTER && (
              <span className={cx("tool-age", inner >= 0 && "tool-age-folded")}>{elapsed(age)}</span>
            )}
            {count && <span className="tool-count">{count}</span>}
            {briefed && (
              <span className="tool-writing" data-tip={writing}>
                <Spinner variant="squares" />
              </span>
            )}
            {stoppable && (
              <IconButton
                icon="stop"
                tone="danger"
                className="tool-stop"
                label={
                  op
                    ? `Stop ${SHIP_THE[op]}: this step is killed, and what it printed so far stays`
                    : background
                      ? "Kill what the command left running; what it printed so far stays"
                      : "Kill the command and everything it started; what it printed so far stays"
                }
                onClick={(e) => {
                  // the press is the button's, not the summary's: a click on the line opens the row
                  e.preventDefault();
                  e.stopPropagation();
                  sock?.send({ t: "exec-stop", ...stoppable });
                }}
              />
            )}
          </>
        }
      >
        {run && run.length > 0 && (
          <div className="spawn-run">
            {run.map((e, i) => (
              <ToolRow
                key={e.at}
                tools={e.tools}
                next={e.next}
                since={i === inner ? since : undefined}
                queued={waiting?.has(i)}
                roots={roots}
                worktreeId={worktreeId}
              />
            ))}
          </div>
        )}
        {/* a spawn's own output is the subagent's narration and then its report: it comes last,
            being the last thing the subagent did */}
        {net ? (
          <NetPart text={net} item={head} roots={roots} worktreeId={worktreeId} />
        ) : (
          tools.map((t) => <ToolPart key={t.id} item={t} roots={roots} worktreeId={worktreeId} />)
        )}
      </Fold>
    );
  },
  (a, b) =>
    a.live === b.live &&
    a.working === b.working &&
    a.since === b.since &&
    a.queued === b.queued &&
    a.next === b.next &&
    a.roots === b.roots &&
    a.worktreeId === b.worktreeId &&
    a.marked === b.marked &&
    sameTools(a.tools, b.tools) &&
    sameRun(a.run, b.run),
);

/** the agent asked for credentials: one button per login method it offered. A terminal method runs
 * as the worktree's login tab, which the card opens tall enough to read a link in; an agent method
 * runs inside the adapter (browser, or the key pasted here). Either way the daemon sends the
 * refused message again once the login succeeds, and a login started here closes the pane it
 * opened. "send again" is for a login done somewhere else. `rejected` means the agent had a
 * credential and the provider refused it: the error above says what it said. */
function AuthCard({ item }: { item: Extract<ChatItem, { kind: "auth" }> }) {
  const sock = useSock();
  const dispatch = useDispatch();
  const id = useStore((s) => s.activeId);
  const termOpen = useStore((s) => s.layout.term);
  const loginRunning = useStore((s) => s.rows.find((r) => r.id === s.activeId)?.login ?? false);
  const policyProblem = useStore((s) => s.managed.problem);
  const [key, setKey] = useState("");
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const started = useRef(false);
  // the tab is shown once the daemon says the login runs: switched to before that, the pane finds
  // no such stream and falls back to the shell
  useOnChange([loginRunning], () => {
    if (loginRunning && started.current && id) dispatch({ a: "term-stream", id, stream: LOGIN_STREAM, tall: true });
  });
  useOnChange([item.done], () => {
    if (item.done && started.current && termOpen) dispatch({ a: "toggle-terminal" });
    started.current = false;
  });
  if (!id) return null;
  const go = (methodId: string, apiKey?: string) => {
    sock?.send({ t: "agent-auth", worktreeId: id, methodId, ...(apiKey ? { apiKey } : {}) });
  };
  const keyMethod = item.methods.find((m) => m.id === keyFor);
  return (
    <div className={`auth-card ${item.done ? "done" : ""}`}>
      <div className="auth-title">
        {item.done
          ? `${item.agentName} is logged in`
          : item.rejected
            ? `${item.agentName}'s credentials were refused`
            : `${item.agentName} is not logged in`}
      </div>
      {!item.done && (
        <div className="auth-methods">
          {item.methods.map((m) =>
            m.needsKey ? (
              <Button
                key={m.id}
                variant="outline"
                on={keyFor === m.id}
                data-tip={m.description}
                onClick={() => setKeyFor(keyFor === m.id ? null : m.id)}
              >
                {m.name}
              </Button>
            ) : (
              <Button
                key={m.id}
                variant="outline"
                data-tip={m.kind === "terminal" ? "opens in the terminal pane" : m.description}
                onClick={() => {
                  go(m.id);
                  if (m.kind === "terminal") started.current = true;
                }}
              >
                {m.name}
              </Button>
            ),
          )}
          <Button
            variant="outline"
            data-tip="after logging in elsewhere (the terminal, another window)"
            onClick={() => sock?.send({ t: "agent-retry", worktreeId: id })}
          >
            send again
          </Button>
        </div>
      )}
      {!item.done && loginRunning && (
        <div className="hint auth-hint">
          paste the code into the login tab below and press Enter; it stays hidden as you paste. Your message sends once
          you are in.
        </div>
      )}
      {!item.done && item.withheld && (
        <div className="hint auth-hint">
          {policyProblem
            ? "the policy file on this machine is invalid, so signing in with a Claude plan is off until it is fixed; toyon doctor says why"
            : "signing in with a Claude plan is managed by your organization"}
        </div>
      )}
      {!item.done && keyMethod && (
        <form
          className="auth-key"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) return;
            go(keyMethod.id, key.trim());
            setKey("");
            setKeyFor(null);
          }}
        >
          <Field
            type="password"
            autoFocus
            placeholder={`${keyMethod.name} for ${item.agentName}`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Button type="submit">use key</Button>
        </form>
      )}
    </div>
  );
}

/** one message in the transcript; memoized so a streaming delta re-renders only the item it
 * touches. Tool calls are `ToolRow` and thoughts `ThoughtRow`, which the log routes to directly:
 * several calls can be one row, and which row is live is a decision about the transcript rather
 * than about any one item. */
export const ChatItemView = memo(function ChatItemView({
  item,
  worktreeId,
  onPickHover,
  marked,
  streaming,
}: {
  item: Exclude<ChatItem, ToolItem | ThinkingItem>;
  worktreeId?: string | null;
  onPickHover?: (p: PickMeta, entering: boolean) => void;
  /** the row the log marks: the message the composer has walked back to, or a search hit's */
  marked?: boolean;
  /** the newest row of a turn still running: its text may end mid-way through something */
  streaming?: boolean;
}) {
  const store = useStoreInstance();
  const sock = useSock();
  const cm = useContextMenu("chat");
  const deps = { sock, dispatch: store.dispatch };
  // the worktree's directory, for a path a row names without its root
  const dirOf = () => {
    const w = worktreeById(store.getState(), worktreeId);
    return w ? w.worktree.path : null;
  };
  // the agent runs at the worktree's real path even when the UI gives it a title-shaped symlink
  const fileRoot = () => worktreeById(store.getState(), worktreeId)?.worktree.path;
  switch (item.kind) {
    case "user": {
      // the person's `@` references are links, as the agent's paths are: the row routes a press
      // on one, and the menu on one is the file's
      const root = fileRoot();
      return (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the links inside are the controls; the root only routes their clicks
        <div
          className="msg-user row-edge"
          data-state={rowState({ cursor: marked })}
          {...cm.contextMenu((_from, target) =>
            messageItems(item, worktreeId ?? null, deps, { link: chatLink(target, root), dir: dirOf() }),
          )}
          onClick={(e) => openMention(e, root, worktreeId, deps)}
        >
          {item.attachments && worktreeId && (
            <div className="msg-attachments">
              {item.attachments.map((a) =>
                a.kind === "image" ? (
                  <SentImageChip key={`${a.kind}-${a.n}`} img={a} src={attachmentUrl(worktreeId, a.file)} />
                ) : a.kind === "file" ? (
                  <FileChip
                    key={`${a.kind}-${a.n}`}
                    className="in-chat"
                    name={a.name}
                    bytes={a.bytes}
                    href={a.text ? attachmentUrl(worktreeId, a.file) : undefined}
                  />
                ) : a.kind === "paste" ? (
                  <PasteChip
                    key={`${a.kind}-${a.n}`}
                    className="in-chat"
                    n={a.n}
                    name={a.name}
                    source={a.source}
                    lines={a.lines}
                    chars={a.chars}
                    preview={a.preview}
                    href={attachmentUrl(worktreeId, a.file)}
                  />
                ) : (
                  <PickChip
                    key={`${a.kind}-${a.n}`}
                    pick={a}
                    dir={dirOf()}
                    className="in-chat"
                    tipText="Hover to highlight on the page"
                    onHover={(entering) => onPickHover?.(a, entering)}
                    worktreeId={worktreeId}
                    onOpen={(path, line) => openSource(store, sock, worktreeId, path, line)}
                  />
                ),
              )}
            </div>
          )}
          <MentionText text={item.text} worktreeId={worktreeId} root={root} />
        </div>
      );
    }
    case "assistant":
      return (
        <Markdown
          text={item.text}
          menu={(link, code) => messageItems(item, worktreeId ?? null, deps, { link, code, dir: dirOf() })}
          marked={marked}
          worktreeId={worktreeId}
          fileRoot={fileRoot()}
          streaming={streaming}
        />
      );
    case "error":
      return (
        <div
          className="msg-assistant msg-error"
          {...cm.contextMenu(() => messageItems(item, worktreeId ?? null, deps))}
        >
          {item.text}
        </div>
      );
    case "auth":
      return <AuthCard item={item} />;
    case "ask": {
      // a question the person answered was the agent's turn speaking and the person replying, and
      // the log reads it as that: the message in the agent's prose, the answer in the person's
      // bubble. Dimming it as a tool exchange put the sentence that decided the turn in the quiet
      // tier under the prose it caused.
      const said = answeredQuestion(item);
      if (!said) return <AskRow item={item} />;
      const answer = answerLines(said.questions, said.answers).join("\n");
      // the bubble offers copy alone: a pick re-sent as prose is not the choice, so it takes no
      // "edit in composer" and no place in the walk
      const bubble = { kind: "assistant" as const, text: answer };
      return (
        <>
          <Markdown
            text={said.message}
            menu={(link, code) =>
              messageItems({ kind: "assistant", text: said.message }, worktreeId ?? null, deps, {
                link,
                code,
                dir: dirOf(),
              })
            }
            worktreeId={worktreeId}
            fileRoot={fileRoot()}
          />
          <div className="msg-user" {...cm.contextMenu(() => messageItems(bubble, worktreeId ?? null, deps))}>
            {answer}
          </div>
        </>
      );
    }
    case "blocked":
      // the reason is on the row rather than in a tooltip: the agent is told only that its request
      // was refused, so it reports a refusal as the person declining, and the row is the only place
      // the person can read whose rule this was
      return (
        <DaemonRow
          icon="lock"
          word="blocked"
          tone="red"
          below={<div className="daemon-below row-dim">{item.reason}</div>}
          {...cm.contextMenu(() => pathItems(item.path, dirOf()))}
        >
          <span className="tool-name">{item.tool}</span>
          {item.path && <span className="tool-hint">{item.path}</span>}
        </DaemonRow>
      );
    case "grafted":
      // layers is the rail's glyph for a worktree merged from several: this divider is where one of
      // those merges shows in the transcript
      return (
        <DaemonRow
          icon="layers"
          word="grafted"
          tone="accent"
          data-tip={`what follows was said in ${item.title} before it was merged in here`}
          data-tip-placement="follow"
        >
          <span className="tool-name">{item.title}</span>
          <span className="tool-hint">{item.branch}</span>
        </DaemonRow>
      );
    case "asked":
      return (
        <DaemonRow icon="chat" word="agent asked" tone="quiet">
          <span className="daemon-text">{item.why}</span>
        </DaemonRow>
      );
    case "landed":
      return <LandedRow item={item} />;
    case "restored":
      return <RestoredRow item={item} />;
    case "adopted":
      // where the found note stood: the chat opens on how the row came to be Toyon's
      return (
        <DaemonRow icon="branch" word="taken over" tone="quiet" at={item.ts}>
          <span className="daemon-text">on {item.branch}, its own branch</span>
        </DaemonRow>
      );
  }
});

/** the gap in the chat, said in the daemon's own row: how long it sat in the archive and what came
 * back, so what reads before and after it is one conversation with a pause. When it came back is
 * the tip's to say: the row sits mid-chat, where nothing around it is timed. */
function RestoredRow({ item }: { item: Extract<ChatItem, { kind: "restored" }> }) {
  return (
    <DaemonRow icon="reload" word="restored" tone="quiet" at={item.ts}>
      <span className="daemon-text">
        after {spanWords(item.ts - item.archivedAt)} in the archive, back on {item.branch}
        {item.uncommitted ? " with its uncommitted changes" : ""}
      </span>
    </DaemonRow>
  );
}

/** the daemon's word on a land that merged, kept on the chat the way the graft divider is, with
 * how long ago it was: the row is the one record of the land a chat read later still shows. The
 * variant siblings it leaves behind are offered here, where the land is read, for as long as they
 * are still rows. */
function LandedRow({ item }: { item: Extract<ChatItem, { kind: "landed" }> }) {
  const sock = useSock();
  const dispatch = useDispatch();
  const left = useStore((s) => item.archiveIds.filter((id) => worktreeById(s, id) !== null).length);
  const ago = useAgo(item.ts);
  return (
    <DaemonRow icon="check" word="landed" tone="aqua" at={item.ts}>
      <span className="daemon-text">
        {item.text}, {ago}
      </span>
      {left > 0 && (
        <Button variant="inline" tone="strong" onClick={() => archiveWorktrees(sock, dispatch, item.archiveIds)}>
          {left > 1 ? `archive ${left} worktrees` : "archive the other worktree"}
        </Button>
      )}
    </DaemonRow>
  );
}
