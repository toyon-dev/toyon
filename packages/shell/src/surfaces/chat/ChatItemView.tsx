import { LOGIN_STREAM, type PickMeta } from "@toyon/shared";
import { Fragment, memo, type ReactNode, useMemo, useRef, useState } from "react";
import { copyText } from "../../state/actions/deps.ts";
import { openFile, openFolder } from "../../state/actions/file.ts";
import { type ChatLink, messageItems, pathItems } from "../../state/actions/message.ts";
import { archiveWorktrees } from "../../state/actions/worktree.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import { type ChatItem, worktreeById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Field } from "../../ui/Field.tsx";
import { useLiveHtml, useOnChange, useReveal, useTail } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { grouped, type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { rowState } from "../../ui/rowState.ts";
import { attachmentUrl } from "../../ws.ts";
import { AskRow } from "./AskRow.tsx";
import { runCalls, sameRun, sameTools, type ThinkingItem, type ToolEntry, type ToolItem } from "./group.ts";
import { SentImageChip } from "./ImageChip.tsx";
import { useMarkdown } from "./markdown.ts";
import { worktreeLink } from "./markdownPaths.ts";
import { netOfCalls } from "./mergeDiffs.ts";
import { PasteChip } from "./PasteChip.tsx";
import { PickChip } from "./PickChip.tsx";
import { languageOf, type Piece, paintCode, paintDiff, pathInDiff } from "./syntax.ts";
import { normalizeThoughtMarkdown, thoughtLine } from "./thought.ts";
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

/** the link at or around an element of a rendered message, and the worktree file it names when
 * the checkout root is known; null when the element is not in a link */
function chatLink(target: Element, root: string | undefined): ChatLink | null {
  const a = target.closest("a");
  if (!a) return null;
  const path = a.getAttribute("data-path");
  if (path) return { kind: "path", path };
  const href = a.getAttribute("href");
  if (!href) return null;
  const file = root ? worktreeLink(root, href) : null;
  return file ? { kind: "file", file } : { kind: "out", href };
}

function openChatLink(
  e: React.MouseEvent,
  root: string | undefined,
  worktreeId: string | null | undefined,
  deps: { dispatch: ReturnType<typeof useDispatch>; sock: ReturnType<typeof useSock> },
) {
  const link = chatLink(e.target as Element, root);
  if (link?.kind !== "file" || !worktreeId) return;
  const target = link.file;
  e.preventDefault();
  if (target.folder) {
    openFolder(deps, { worktreeId, path: target.path });
    return;
  }
  // a message names a file because the agent touched it, so the view is left unsaid and the read
  // opens the diff when there is one, the file otherwise. A line is an address into the file.
  openFile(deps, {
    worktreeId,
    path: target.path,
    ...(target.line ? { view: "file", line: { n: target.line } } : {}),
  });
}

function Markdown({
  text,
  menu,
  marked,
  worktreeId,
  fileRoot,
  streaming,
}: {
  text: string;
  /** the row's menu, told which link the pointer was on, if any: the rendered markup is the row's,
   * so a link inside it has no handler of its own */
  menu: (link: ChatLink | null) => MenuEntry[];
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
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the links inside are the controls; the root only routes their clicks
    <div
      ref={body}
      className="msg-assistant md row-edge"
      data-state={rowState({ cursor: marked })}
      {...cm.contextMenu((_from, target) => menu(chatLink(target, fileRoot)))}
      onClick={(e) => openChatLink(e, fileRoot, worktreeId, { sock, dispatch })}
    />
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
  if (!command && blocks.length === 0) return null;
  return (
    <div className="tool-part">
      {command && <pre className="tool-block cmd">{command}</pre>}
      {blocks.length > 0 && <ToolOut blocks={blocks} path={openable(item, roots)} worktreeId={worktreeId} />}
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

/** one line's worth of code: a span per run that carries a colour or a change, the rest as text.
 * A piece with neither is left bare rather than wrapped, which is most of a file. */
function Painted({ pieces }: { pieces: Piece[] }) {
  return (
    <>
      {pieces.map((p, i) => {
        const cls = `${p.changed ? "ch " : ""}${p.scope ? `sy-${p.scope}` : ""}`.trim();
        // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positional and never reordered
        if (!cls) return <Fragment key={i}>{p.text}</Fragment>;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: same
          <span key={i} className={cls}>
            {p.text}
          </span>
        );
      })}
    </>
  );
}

/** the band a line of the transcript folds out into: a call, a run of calls, or a thought. `auto`
 * is whether the row opens itself, which only the row the agent is on does, so scrolling back over
 * a long turn is a list of one-line rows; a click pins the row either way from then on. A `leaf`
 * has nothing under its line: a call that printed nothing and ran no command. It stays a row, in
 * the same column with the same glyph, but it is not a control: a click opened an empty band with
 * the accent edge down it, and a fill under the pointer promised the same. */
function Fold({
  className,
  state,
  auto,
  leaf,
  label,
  summary,
  menu,
  onToggle,
  children,
}: {
  className: string;
  /** the row's data-state words (ui/rowState.ts) */
  state?: string;
  auto: boolean;
  leaf?: boolean;
  label: string;
  summary: ReactNode;
  /** what a right-click on the row offers; told whether the row is open, and how to fold it, or
   * that there is nothing to fold */
  menu: (fold: { open: boolean; leaf: boolean; toggle: () => void }) => MenuEntry[];
  /** the row opened or closed, by a click or by `auto`, once the browser has applied it */
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const card = useRef<HTMLDetailsElement>(null);
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
      onToggle={(e) => onToggle?.(e.currentTarget.open)}
      {...cm.contextMenu(() => menu({ open, leaf: !!leaf, toggle }))}
      // clicking the output selects text and leaves focus on the body, so the card takes it: that is
      // what makes Escape close the row you are reading, not only the one whose chip you clicked
      tabIndex={-1}
      onPointerDown={() => card.current?.focus({ preventScroll: true })}
      onKeyDown={(e) => {
        // Escape belongs to the row that has focus. Anything less local (the overlay, picker,
        // terminal and diff ladder in app/keys.ts) keeps the key otherwise, and a second press
        // falls through to it.
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
      {children}
    </details>
  );
}

/** The agent's reasoning, folded like a call: it is addressed to nobody, and the message after it
 * says whatever in it mattered, so a paragraph of it in the flow read as an answer that had lost
 * its colour. The line is one word, the way a call's is a path: its first sentence was a sentence
 * of prose in a column of file names, and the wrong tier of thing to be ellipsised. It is the one
 * row that opens itself, and it stays open past the calls it set off, which print a line each and
 * put nothing in its place (openRow in group.ts). The body is the message's markdown, not a call's
 * mono: it is prose.
 *
 * The word and its shine answer a narrower question than the fold does: the agent is thinking
 * while this is the newest thing in the log, and a row still reading "Thinking" over a call that
 * has started says the wrong thing about where the agent is. */
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
  const html = useMarkdown(normalizeThoughtMarkdown(item.text), fileRoot ? { fileRoot } : undefined);
  const sock = useSock();
  const dispatch = useDispatch();
  const word = streaming ? "Thinking" : "Thought";
  // The body stops growing at a share of the transcript (chat.css, .thought-out) and scrolls
  // inside, so it tails the way the log does: the newest line in view while the agent writes,
  // until the reader scrolls up. A body that is not open has no height and the pin is a no-op,
  // so it costs nothing on the closed rows of an old turn.
  const body = useRef<HTMLDivElement>(null);
  useTail(body);
  // the DOMPurify-sanitized markup goes in through the hook, which keeps a selection through the
  // re-renders of a thought still streaming
  useLiveHtml(body, html);
  // A folded row keeps its body's scroll (the browser hides the contents rather than dropping
  // them), so a finished thought opened later to be read would open where the tail left it, on
  // its last line. A thought at rest is read from the start; one still streaming opens tailed.
  const onToggle = (isOpen: boolean) => {
    const el = body.current;
    if (!el || !isOpen || streaming) return;
    el.scrollTop = 0;
  };
  // a finished thought of one line is the line, printed where the word would go, with nothing
  // under it: a headline per step (Codex) folded into a card each was a column of lids
  const line = streaming ? "" : thoughtLine(item.text);
  if (line) {
    return (
      <Fold
        className="tool-row"
        auto={false}
        leaf
        label={line}
        menu={() => grouped([[{ id: "copy", label: "copy thought", onClick: () => copyText(item.text) }]])}
        summary={
          <>
            <Icon name="bulb" className="tool-icon" />
            <span className="tool-hint thought-line">{line}</span>
          </>
        }
      >
        {null}
      </Fold>
    );
  }
  return (
    <Fold
      className="tool-row"
      auto={!!open}
      label={word}
      onToggle={onToggle}
      menu={(fold) =>
        grouped([
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
      <div className="tool-part">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the links inside are the controls; the root only routes their clicks */}
        <div
          ref={body}
          className="tool-out thought-out md"
          onClick={(e) => openChatLink(e, fileRoot, worktreeId, { sock, dispatch })}
        />
      </div>
    </Fold>
  );
});

/** a call in the transcript, or a run of calls that did the same thing to the same file, or the
 * call that started a subagent with that subagent's rows folded under it */
export const ToolRow = memo(
  function ToolRow({
    tools,
    run,
    next,
    live,
    working,
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
    /** the subagent this call started is still at work (subagentsAtWork in group.ts). Its rows sit
     * under a closed fold, so this line's shine is what says so, and it holds across the gaps
     * between the subagent's calls: a shine that came and went with each call would restart its
     * sweep every time and strobe rather than travel. */
    working?: boolean;
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
    const streaming = !tools.at(-1)?.done;
    // the row is alive while its own last call runs, and while the agent writes the run's next
    // call: that one has no row until its path is in, and this row's shine is what says it is coming
    const alive = streaming || !!next;
    // A spawn row shines while its subagent works. A spawn run in the background returns at once,
    // so its own call says nothing about the subagent; the log says when it is at work.
    const running = alive || !!working;
    // The log decides which row opens itself, and it hands the row two answers: the turn's one
    // self-opening row (openRow in group.ts, reasoning only) and the newest `!` command, which is
    // open from the start because what it printed is the reason the person ran it. A subagent's
    // row is the third case and decides for itself: open while its own call runs, since its rows
    // are where the work is, and closed once that returns, when what it did is a line with a count
    // and the message after it says what came of it. A background spawn's row stays closed while
    // its subagent works: opening on each of its calls would flap the fold shut and open.
    const auto = !!live || (!!run && alive);
    const text = toolLabel(head, roots);
    // the agent is still typing the call: the row says what it is typing, in the slot the path or
    // command will take, and the glyph alone names the kind, as on every row that has its detail
    const writing = streaming ? composing(head) : "";
    const { label, icon } = text;
    // a guardian review's line is its verdict, read off the report it printed (toolCall.ts)
    const guardian = isGuardian(head);
    const name = writing ? "" : guardian ? "Guardian" : text.name;
    const hint = writing || (guardian ? guardianHint(head.output ?? "") : text.hint);
    // nothing under the line: no subagent rows, no net change, and no call that ran a command or
    // printed a block (ToolPart draws nothing for those). Read the same way ToolPart does, so the
    // row is a leaf exactly when opening it would show nothing.
    const leaf =
      !(run && run.length > 0) &&
      !net &&
      tools.every((t) => !toolLabel(t, roots).command && toolBlocks(t, t.output ?? "").length === 0);
    const calls = run ? runCalls(run) : 0;
    const what = [label, hint].filter(Boolean).join(" ");
    const count = run ? `${calls} ${calls === 1 ? "call" : "calls"}` : tools.length > 1 ? `×${tools.length}` : "";
    const store = useStoreInstance();
    const sock = useSock();
    return (
      <Fold
        className={cx(
          "tool-row",
          tools.some((t) => t.isError) && "error",
          head.parentToolId && "nested",
          run && "spawn",
        )}
        state={rowState({ cursor: marked })}
        auto={auto}
        leaf={leaf}
        label={run ? `${what}, ${count}` : tools.length > 1 ? `${what}, ${tools.length} calls` : what}
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
            {name && <span className={cx("tool-name", running && "live-text")}>{name}</span>}
            {hint && <span className={cx("tool-hint", running && "live-text")}>{hint}</span>}
            {count && <span className="tool-count">{count}</span>}
          </>
        }
      >
        {run && run.length > 0 && (
          <div className="spawn-run">
            {run.map((e) => (
              <ToolRow key={e.at} tools={e.tools} next={e.next} roots={roots} worktreeId={worktreeId} />
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
    case "user":
      return (
        <div
          className="msg-user row-edge"
          data-state={rowState({ cursor: marked })}
          {...cm.contextMenu(() => messageItems(item, worktreeId ?? null, deps))}
        >
          {item.attachments && worktreeId && (
            <div className="msg-attachments">
              {item.attachments.map((a) =>
                a.kind === "image" ? (
                  <SentImageChip key={`${a.kind}-${a.n}`} img={a} src={attachmentUrl(worktreeId, a.file)} />
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
                    onOpen={(path, line) => openSource(store, sock, worktreeId, path, line)}
                  />
                ),
              )}
            </div>
          )}
          {item.text}
        </div>
      );
    case "assistant":
      return (
        <Markdown
          text={item.text}
          menu={(link) => messageItems(item, worktreeId ?? null, deps, { link, dir: dirOf() })}
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
    case "ask":
      return <AskRow item={item} worktreeId={worktreeId} />;
    case "blocked":
      // the reason is on the row rather than in a tooltip: the agent is told only that its request
      // was refused, so it reports a refusal as the person declining, and the row is the only place
      // the person can read whose rule this was
      return (
        <div className="blocked-row" {...cm.contextMenu(() => pathItems(item.path, dirOf()))}>
          <div className="blocked-head">
            <span className="blocked-tag">blocked</span>
            <span className="tool-name">{item.tool}</span>
            {item.path && <span className="tool-hint">{item.path}</span>}
          </div>
          <div className="blocked-why row-dim">{item.reason}</div>
        </div>
      );
    case "grafted":
      return (
        <div
          className="graft-row"
          data-tip={`what follows was said in ${item.title} before it was merged in here`}
          data-tip-placement="follow"
        >
          <span className="graft-tag">grafted</span>
          <span className="tool-name">{item.title}</span>
          <span className="tool-hint">{item.branch}</span>
        </div>
      );
    case "landed":
      return <LandedRow item={item} />;
  }
});

/** the daemon's word on a land that merged, kept on the chat the way the graft divider is. The
 * variant siblings it leaves behind are offered here, where the land is read, for as long as they
 * are still rows. */
function LandedRow({ item }: { item: Extract<ChatItem, { kind: "landed" }> }) {
  const sock = useSock();
  const dispatch = useDispatch();
  const left = useStore((s) => item.archiveIds.filter((id) => worktreeById(s, id) !== null).length);
  return (
    <div className="landed-row">
      <span className="landed-tag">landed</span>
      <span className="landed-text">{item.text}</span>
      {left > 0 && (
        <Button variant="inline" tone="strong" onClick={() => archiveWorktrees(sock, dispatch, item.archiveIds)}>
          {left > 1 ? `archive ${left} worktrees` : "archive the other worktree"}
        </Button>
      )}
    </div>
  );
}
