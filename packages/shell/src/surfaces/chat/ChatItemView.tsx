import { type PickMeta, SHELL_TOOL } from "@toyon/shared";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSock, useStore, useStoreInstance } from "../../state/context.tsx";
import { openSource } from "../../state/openSource.ts";
import type { ChatItem } from "../../state/store.ts";
import { Button } from "../../ui/Button.tsx";
import { useReveal } from "../../ui/hooks.ts";
import { Icon } from "../../ui/Icon.tsx";
import { attachmentUrl } from "../../ws.ts";
import { AskCard } from "./AskCard.tsx";
import { sameTools, type ToolItem } from "./group.ts";
import { SentImageChip } from "./ImageChip.tsx";
import { netOfCalls } from "./mergeDiffs.ts";
import { PasteChip } from "./PasteChip.tsx";
import { PickChip } from "./PickChip.tsx";
import { languageOf, type Piece, paintCode, paintDiff, pathInDiff } from "./syntax.ts";
import { AUTO_OPEN, callPath, diffLines, type OutputBlock, relPath, toolBlocks, toolLabel } from "./toolCall.ts";

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

function Markdown({ text }: { text: string }) {
  const html = useThrottledMarkdown(text);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
  return <div className="msg-assistant md" dangerouslySetInnerHTML={{ __html: html }} />;
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
                onClick={() => worktreeId && sock?.send({ t: "file-diff", worktreeId, path })}
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

/** a call in the transcript, or a run of calls that did the same thing to the same file. Only the
 * run the agent is on is open, so scrolling back over a long turn is a list of one-line rows; a
 * click pins the row either way from then on. */
export const ToolRow = memo(
  function ToolRow({
    tools,
    live,
    roots,
    worktreeId,
  }: {
    tools: ToolItem[];
    live?: boolean;
    roots?: string[];
    worktreeId?: string | null;
  }) {
    const [pinned, setPinned] = useState<boolean | null>(null);
    const card = useRef<HTMLDetailsElement>(null);
    // output that lands below the pane is scrolled into view once the row has opened
    const reveal = useReveal(".chat-log");
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
    // the row the agent is on opens itself, but only where its output is worth watching arrive: a
    // read or a search is a file you asked for, and having each one throw a panel open walks the
    // message you were reading off the top of the log. A command the person ran themselves is
    // open from the start: what it printed is the reason they ran it.
    const open = pinned ?? (head.name === SHELL_TOOL || (!!live && AUTO_OPEN.has(head.toolKind ?? "other")));
    const { label, name, icon, hint } = toolLabel(head, roots);
    const running = !tools.at(-1)?.done;
    const what = [label, hint].filter(Boolean).join(" ");
    return (
      <details
        ref={card}
        className={`tool-row ${tools.some((t) => t.isError) ? "error" : ""}`}
        open={open}
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
          aria-label={tools.length > 1 ? `${what}, ${tools.length} calls` : what}
          onClick={(e) => {
            e.preventDefault();
            if (!open) reveal(e.currentTarget);
            setPinned(!open);
          }}
        >
          {running ? <span className="spinner">●</span> : <Icon name={icon} className="tool-icon" />}
          {name && <span className="tool-name">{name}</span>}
          {hint && <span className="tool-hint">{hint}</span>}
          {tools.length > 1 && <span className="tool-count">×{tools.length}</span>}
        </summary>
        {net ? (
          <NetPart text={net} item={head} roots={roots} worktreeId={worktreeId} />
        ) : (
          tools.map((t) => <ToolPart key={t.id} item={t} roots={roots} worktreeId={worktreeId} />)
        )}
      </details>
    );
  },
  (a, b) => a.live === b.live && a.roots === b.roots && a.worktreeId === b.worktreeId && sameTools(a.tools, b.tools),
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
          <input
            className="field"
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
 * touches. Tool calls are `ToolRow`, which the log routes to directly: several of them can be one
 * row, which is a decision about the transcript rather than about any one item. */
export const ChatItemView = memo(function ChatItemView({
  item,
  worktreeId,
  onPickHover,
}: {
  item: Exclude<ChatItem, { kind: "tool" }>;
  worktreeId?: string | null;
  onPickHover?: (p: PickMeta, entering: boolean) => void;
}) {
  const store = useStoreInstance();
  const sock = useSock();
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-user">
          {item.images && worktreeId && (
            <div className="msg-images">
              {item.images.map((img) => (
                <SentImageChip key={img.n} img={img} src={attachmentUrl(worktreeId, img.file)} />
              ))}
            </div>
          )}
          {item.pastes && worktreeId && (
            <div className="msg-images">
              {item.pastes.map((p) => (
                <PasteChip
                  key={p.n}
                  className="in-chat"
                  n={p.n}
                  name={p.name}
                  lines={p.lines}
                  chars={p.chars}
                  preview={p.preview}
                  href={attachmentUrl(worktreeId, p.file)}
                />
              ))}
            </div>
          )}
          {item.text}
          {item.pick && (
            <PickChip
              pick={item.pick}
              className="in-chat"
              tipText="Hover to highlight on the page"
              onHover={(entering) => onPickHover?.(item.pick!, entering)}
              onOpen={worktreeId ? (path, line) => openSource(store, sock, worktreeId, path, line) : undefined}
            />
          )}
        </div>
      );
    case "assistant":
      return <Markdown text={item.text} />;
    case "thinking":
      return <div className="msg-thinking">{item.text}</div>;
    case "error":
      return <div className="msg-assistant msg-error">{item.text}</div>;
    case "auth":
      return <AuthCard item={item} />;
    case "ask":
      return <AskCard item={item} />;
    case "blocked":
      return (
        <div className="blocked-row" data-tip={item.reason}>
          <span className="blocked-tag">blocked</span>
          <span className="tool-name">{item.tool}</span>
          <span className="tool-hint">{item.path}</span>
        </div>
      );
  }
});
