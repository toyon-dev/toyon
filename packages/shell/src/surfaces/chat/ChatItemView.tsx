import type { PickMeta } from "@toyon/shared";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { ChatItem } from "../../state/store.ts";
import { Icon } from "../../ui/Icon.tsx";
import { attachmentUrl } from "../../ws.ts";
import { AskCard } from "./AskCard.tsx";
import { SentImageChip } from "./ImageChip.tsx";
import { PasteChip } from "./PasteChip.tsx";
import { PickChip } from "./PickChip.tsx";
import { diffLines, toolBlocks, toolLabel } from "./toolCall.ts";

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

/** what the agent wrote under the call: its prose as prose, its fenced blocks as blocks, and a
 * diff colored by line rather than printed as backticks */
function ToolOutput({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const blocks = useMemo(() => toolBlocks(item, item.output ?? ""), [item]);
  return (
    <div className="tool-out">
      {blocks.map((b, i) =>
        b.diff ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and never reordered
          <pre key={i} className="tool-block diff">
            {diffLines(b.text).map((line, j) =>
              // a hunk header is a jump in the file, not a line of it: it draws as the rule between
              // two stretches of code, with the line numbers left on hover
              line.kind === "hunk" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: same
                <span key={j} className="dl hunk" title={line.text} />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: same
                <span key={j} className={`dl ${line.kind}`}>
                  {line.text || " "}
                </span>
              ),
            )}
          </pre>
        ) : b.code ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: same
          <pre key={i} className="tool-block">
            {b.text}
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

/** one call in the transcript. Only the call in flight is open, so scrolling back over a long turn
 * is a list of one-line rows; a click pins the row either way from then on. */
function ToolRow({
  item,
  live,
  roots,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  live?: boolean;
  roots?: string[];
}) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? !!live;
  const card = useRef<HTMLDetailsElement>(null);
  const { label, name, icon, hint, command } = toolLabel(item, roots);
  return (
    <details
      ref={card}
      className={`tool-row ${item.isError ? "error" : ""}`}
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
        aria-label={hint ? `${label} ${hint}` : label}
        onClick={(e) => {
          e.preventDefault();
          setPinned(!open);
        }}
      >
        {!item.done ? <span className="spinner">●</span> : <Icon name={icon} className="tool-icon" />}
        {name && <span className="tool-name">{name}</span>}
        {hint && <span className="tool-hint">{hint}</span>}
      </summary>
      {command && <pre className="tool-block cmd">{command}</pre>}
      {item.output ? <ToolOutput item={item} /> : null}
    </details>
  );
}

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
              <button
                key={m.id}
                className={`btn btn-outline ${keyFor === m.id ? "on" : ""}`}
                data-tip={m.description}
                onClick={() => setKeyFor(keyFor === m.id ? null : m.id)}
              >
                {m.name}
              </button>
            ) : (
              <button
                key={m.id}
                className="btn btn-outline"
                data-tip={m.kind === "terminal" ? "runs in the terminal pane" : m.description}
                onClick={() => {
                  go(m.id);
                  if (m.kind === "terminal" && !termOpen) dispatch({ a: "toggle-terminal" });
                }}
              >
                {m.name}
              </button>
            ),
          )}
          <button
            className="btn btn-outline"
            data-tip="after logging in elsewhere (the terminal, another window)"
            onClick={() => sock?.send({ t: "agent-retry", worktreeId: id })}
          >
            send again
          </button>
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
          <button className="btn" type="submit">
            use key
          </button>
        </form>
      )}
    </div>
  );
}

/** one chat row; memoized so a streaming delta re-renders only the item it touches */
export const ChatItemView = memo(function ChatItemView({
  item,
  worktreeId,
  live,
  roots,
  onPickHover,
}: {
  item: ChatItem;
  worktreeId?: string | null;
  /** this is the call the agent is on: it opens itself until the next one starts */
  live?: boolean;
  /** worktree paths to strip off a tool's file path (stable identity: memoized by the caller) */
  roots?: string[];
  onPickHover?: (p: PickMeta, entering: boolean) => void;
}) {
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
    case "tool":
      return <ToolRow item={item} live={live} roots={roots} />;
  }
});
