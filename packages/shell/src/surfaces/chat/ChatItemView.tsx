import { type PickMeta, SHELL_TOOL } from "@toyon/shared";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { Fragment, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../../state/actions/deps.ts";
import { openFile } from "../../state/actions/file.ts";
import { blockedItems, messageItems } from "../../state/actions/message.ts";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import { type ChatItem, worktreeById } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { cx } from "../../ui/cx.ts";
import { Field } from "../../ui/Field.tsx";
import { useReveal } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { grouped, type MenuEntry, useContextMenu } from "../../ui/menu.ts";
import { rowState } from "../../ui/rowState.ts";
import { Spinner } from "../../ui/Spinner.tsx";
import { attachmentUrl } from "../../ws.ts";
import { wtDir } from "../util.ts";
import { AskCard } from "./AskCard.tsx";
import { sameTools, type ThinkingItem, type ToolItem } from "./group.ts";
import { SentImageChip } from "./ImageChip.tsx";
import { netOfCalls } from "./mergeDiffs.ts";
import { PasteChip } from "./PasteChip.tsx";
import { PickChip } from "./PickChip.tsx";
import { languageOf, type Piece, paintCode, paintDiff, pathInDiff } from "./syntax.ts";
import { AUTO_OPEN, callPath, diffLines, type OutputBlock, relPath, toolBlocks, toolLabel } from "./toolCall.ts";
import { toolRowItems } from "./toolRowItems.ts";

// a fenced block the agent wrote in a message is the same code as a fenced block under a tool call,
// so it is coloured by the same seven. marked hands the block over before it escapes it, and
// returning false hands one back in a language we have no grammar for.
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = languageOf((lang ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "", "");
      if (!language) return false;
      const body = paintCode(text, language)
        .map((line) =>
          line
            .map((p) => (p.scope ? `<span class="sy-${p.scope}">${escapeHtml(p.text)}</span>` : escapeHtml(p.text)))
            .join(""),
        )
        .join("\n");
      return `<pre><code>${body}</code></pre>\n`;
    },
  },
});

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));

const render = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }) as string);

/** parsing a long message on every streamed token is O(n²); while it streams, re-render at most
 * every ~100ms and settle immediately once the text stops changing */
function useThrottledMarkdown(text: string): string {
  const [html, setHtml] = useState(() => render(text));
  const lastAt = useRef(0);
  useEffect(() => {
    const since = performance.now() - lastAt.current;
    if (since >= 100) {
      lastAt.current = performance.now();
      setHtml(render(text));
      return;
    }
    const t = setTimeout(() => {
      lastAt.current = performance.now();
      setHtml(render(text));
    }, 100 - since);
    return () => clearTimeout(t);
  }, [text]);
  return html;
}

function Markdown({ text, menu }: { text: string; menu: () => MenuEntry[] }) {
  const html = useThrottledMarkdown(text);
  const cm = useContextMenu("chat");
  return (
    <div
      className="msg-assistant md"
      {...cm.contextMenu(menu)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
      dangerouslySetInnerHTML={{ __html: html }}
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
    const language = languageOf(b.lang, b.diff ? path || pathInDiff(b.text) : "");
    if (b.diff) {
      const lines = diffLines(b.text);
      return { ...b, lines, painted: paintDiff(lines, language) };
    }
    return { ...b, lines: [], painted: paintCode(b.text, language) };
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
 * a long turn is a list of one-line rows; a click pins the row either way from then on. */
function Fold({
  className,
  state,
  auto,
  label,
  summary,
  menu,
  children,
}: {
  className: string;
  /** the row's data-state words (ui/rowState.ts) */
  state?: string;
  auto: boolean;
  label: string;
  summary: ReactNode;
  /** what a right-click on the row offers; told whether the row is open, and how to fold it */
  menu: (fold: { open: boolean; toggle: () => void }) => MenuEntry[];
  children: ReactNode;
}) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const card = useRef<HTMLDetailsElement>(null);
  // output that lands below the pane is scrolled into view once the row has opened. The hook is
  // handed the card, not the summary: the summary is the one part of the row that is already on
  // the page, and measuring it alone found nothing to reveal.
  const reveal = useReveal(".chat-log");
  const open = pinned ?? auto;
  const toggle = () => {
    if (!open) reveal(card.current);
    setPinned(!open);
  };
  const cm = useContextMenu("chat");
  return (
    <details
      ref={card}
      className={className}
      data-state={state}
      open={open}
      {...cm.contextMenu(() => menu({ open, toggle }))}
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
      {/* controlled: let the click set `pinned` rather than the element toggling itself */}
      <summary
        aria-label={label}
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
 * of prose in a column of file names, and the wrong tier of thing to be ellipsised. Open while it
 * streams, since a thought arriving is the only sign the agent is working, and closed by whatever
 * comes next. It waits for its first words before it opens: an empty panel under a spinner says
 * less than the spinner alone. The body is the message's markdown, not a call's mono: it is prose. */
export const ThoughtRow = memo(function ThoughtRow({ item, live }: { item: ThinkingItem; live?: boolean }) {
  const html = useThrottledMarkdown(item.text);
  const word = live ? "Thinking" : "Thought";
  return (
    <Fold
      className="tool-row"
      auto={!!live && !!item.text.trim()}
      label={word}
      menu={(fold) =>
        grouped([
          [{ id: "copy", label: "copy thought", onClick: () => copyText(item.text) }],
          [{ id: "fold", label: fold.open ? "collapse" : "expand", onClick: fold.toggle }],
        ])
      }
      summary={
        <>
          {live ? <span className="spinner">●</span> : <Icon name="bulb" className="tool-icon" />}
          <span className="tool-name">{word}</span>
        </>
      }
    >
      <div className="tool-part">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output */}
        <div className="tool-out thought-out md" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </Fold>
  );
});

/** a call in the transcript, or a run of calls that did the same thing to the same file */
export const ToolRow = memo(
  function ToolRow({
    tools,
    live,
    roots,
    worktreeId,
    rail,
    marked,
  }: {
    tools: ToolItem[];
    live?: boolean;
    roots?: string[];
    worktreeId?: string | null;
    /** which subagent's rail this row sits on, while more than one of them is running */
    rail?: number;
    /** the composer has walked back to the command this row ran */
    marked?: boolean;
  }) {
    // every call in a run prints the same line, so the first one is the row
    const head = tools[0]!;
    // While the agent is in the file the row is a feed: each call appends what it just did, and
    // nothing above it moves. Once it has moved on the run is over and the row is the record of it,
    // which is the change the run came to rather than one diff per call printing the same
    // neighbourhood again (mergeDiffs.ts). The swap lands on the same render that closes the row,
    // so it is only ever seen on a row somebody pinned open.
    const net = useMemo(
      () => (live ? null : netOfCalls(tools.map((t) => toolBlocks(t, t.output ?? "")))),
      [tools, live],
    );
    // the live row (openRow in group.ts) opens itself, but only where its output is worth watching
    // arrive: a read or a search is a file you asked for, and having each one throw a panel open
    // walks the message you were reading off the top of the log. A command the person ran themselves is
    // open from the start, since what it printed is the reason they ran it, and the next one
    // closes it: a series of `!` commands is a prompt, not a stack of listings.
    const auto = !!live && (head.name === SHELL_TOOL || AUTO_OPEN.has(head.toolKind ?? "other"));
    const { label, name, icon, hint } = toolLabel(head, roots);
    const running = !tools.at(-1)?.done;
    const what = [label, hint].filter(Boolean).join(" ");
    const store = useStoreInstance();
    const sock = useSock();
    return (
      <Fold
        className={cx(
          "tool-row",
          tools.some((t) => t.isError) && "error",
          head.parentToolId && "nested",
          head.subagent && "spawn",
          rail !== undefined && `rail-${rail}`,
        )}
        state={rowState({ cursor: marked })}
        auto={auto}
        label={tools.length > 1 ? `${what}, ${tools.length} calls` : what}
        menu={(fold) => {
          const w = worktreeById(store.getState(), worktreeId);
          const wt = w ? { id: w.worktree.id, dir: wtDir(w.worktree) } : null;
          return toolRowItems(tools, roots ?? [], wt, { sock, dispatch: store.dispatch }, fold);
        }}
        summary={
          <>
            {running ? <Spinner className="tool-spinner" /> : <Icon name={icon} className="tool-icon" />}
            {name && <span className="tool-name">{name}</span>}
            {hint && <span className="tool-hint">{hint}</span>}
            {tools.length > 1 && <span className="tool-count">×{tools.length}</span>}
          </>
        }
      >
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
    a.roots === b.roots &&
    a.worktreeId === b.worktreeId &&
    a.rail === b.rail &&
    a.marked === b.marked &&
    sameTools(a.tools, b.tools),
);

/** the agent asked for credentials: one button per login method it offered. A terminal method runs
 * in the worktree's terminal pane (the daemon types the command once the pane is open); an agent
 * method runs inside the adapter (browser, or the key pasted here). The refused message is sent
 * again by the daemon after a successful login; "send again" covers the terminal path. `rejected`
 * means the agent had a credential and the provider refused it: the error above says what it said. */
function AuthCard({ item }: { item: Extract<ChatItem, { kind: "auth" }> }) {
  const sock = useSock();
  const dispatch = useDispatch();
  const id = useStore((s) => s.activeId);
  const termOpen = useStore((s) => s.termOpen);
  const [key, setKey] = useState("");
  const [keyFor, setKeyFor] = useState<string | null>(null);
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
                data-tip={m.kind === "terminal" ? "runs in the terminal pane" : m.description}
                onClick={() => {
                  go(m.id);
                  if (m.kind === "terminal" && !termOpen) dispatch({ a: "toggle-terminal" });
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
}: {
  item: Exclude<ChatItem, ToolItem | ThinkingItem>;
  worktreeId?: string | null;
  onPickHover?: (p: PickMeta, entering: boolean) => void;
  /** the composer has walked back to this message */
  marked?: boolean;
}) {
  const store = useStoreInstance();
  const sock = useSock();
  const cm = useContextMenu("chat");
  const deps = { sock, dispatch: store.dispatch };
  // the worktree's directory, for a path a row names without its root
  const dirOf = () => {
    const w = worktreeById(store.getState(), worktreeId);
    return w ? wtDir(w.worktree) : null;
  };
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
      return <Markdown text={item.text} menu={() => messageItems(item, worktreeId ?? null, deps)} />;
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
      return <AskCard item={item} />;
    case "blocked":
      // the reason is on the row rather than in a tooltip: the agent is told only that its request
      // was refused, so it reports a refusal as the person declining, and the row is the only place
      // the person can read whose rule this was
      return (
        <div className="blocked-row" {...cm.contextMenu(() => blockedItems(item.path, dirOf()))}>
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
  }
});
