import type { PickMeta } from "@toyon/shared";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useEffect, useRef, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import type { ChatItem } from "../../state/store.ts";
import { PickChip } from "./PickChip.tsx";

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

function toolHint(item: Extract<ChatItem, { kind: "tool" }>): string {
  const input = item.input as Record<string, unknown> | null;
  const v = input ? (input.file_path ?? input.command ?? input.path ?? input.pattern) : undefined;
  if (typeof v === "string" && v) return v;
  // ACP agents describe the call in the title ("Write src/a.ts"); avoid repeating the name
  return item.title && item.title !== item.name ? item.title : "";
}

/** the agent asked for credentials: one button per login method it offered. A terminal method runs
 * in the worktree's terminal pane (the daemon types the command once the pane is open); an agent
 * method runs inside the adapter (browser, or the key pasted here). The refused message is sent
 * again by the daemon after a successful login; "send again" covers the terminal path. */
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
        {item.done ? `${item.agentName} is logged in` : `${item.agentName} is not logged in`}
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
  onPickHover,
}: {
  item: ChatItem;
  onPickHover?: (p: PickMeta, entering: boolean) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-user">
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
    case "blocked":
      return (
        <div className="blocked-row" data-tip={item.reason}>
          <span className="blocked-tag">blocked</span>
          <span className="tool-name">{item.tool}</span>
          <span className="tool-hint">{item.path}</span>
        </div>
      );
    case "tool": {
      const hint = toolHint(item);
      return (
        <details className={`tool-row ${item.isError ? "error" : ""}`}>
          <summary>
            {!item.done && <span className="spinner">●</span>}
            <span className="tool-name">{item.name}</span>
            <span className="tool-hint">{hint}</span>
          </summary>
          {item.output ? <pre>{item.output}</pre> : null}
        </details>
      );
    }
  }
});
