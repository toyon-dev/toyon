import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { WorktreeStatus } from "@orchardist/shared";
import { DaemonSocket } from "./ws.ts";
import { initial, reducer, type ChatItem, type State } from "./store.ts";
import { lineDiff } from "./diff.ts";

export function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  const sockRef = useRef<DaemonSocket | null>(null);

  useEffect(() => {
    const sock = new DaemonSocket(
      (msg) => dispatch({ a: "server", msg }),
      (v) => dispatch({ a: "connected", v }),
    );
    sockRef.current = sock;
    return () => sock.dispose();
  }, []);

  const sock = sockRef.current;
  const active = state.worktrees.find((w) => w.worktree.id === state.activeId) ?? null;

  // subscribe when the active worktree changes
  useEffect(() => {
    if (state.activeId && sock) sock.send({ t: "subscribe", worktreeId: state.activeId });
  }, [state.activeId, state.connected]);

  // keyboard: cmd+1..9 switch tabs, cmd+k new worktree, cmd+b/j toggle docks, esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key >= "1" && e.key <= "9") {
        const wt = state.worktrees[Number(e.key) - 1];
        if (wt) { e.preventDefault(); dispatch({ a: "activate", id: wt.worktree.id }); }
      } else if (e.metaKey && e.key === "k") {
        e.preventDefault();
        dispatch({ a: "show-prompt", v: true });
      } else if (e.metaKey && e.key === "b") {
        e.preventDefault();
        dispatch({ a: "toggle-left" });
      } else if (e.metaKey && e.key === "j") {
        e.preventDefault();
        dispatch({ a: "toggle-right" });
      } else if (e.key === "Escape") {
        if (state.diff) dispatch({ a: "close-diff" });
        if (state.showPrompt) dispatch({ a: "show-prompt", v: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.worktrees, state.diff, state.showPrompt]);

  const repo = state.repos[0] ?? null;

  return (
    <div className="app">
      <div className="docks">
        <LeftDock state={state} dispatch={dispatch} sock={sock} />
        <Center state={state} active={active} dispatch={dispatch} sock={sock} repo={repo} />
        <RightDock state={state} active={active} sock={sock} />
      </div>
      <StatusBar state={state} active={active} dispatch={dispatch} />
    </div>
  );
}

type Sock = DaemonSocket | null;
type Dispatch = (a: Parameters<typeof reducer>[1]) => void;

function LeftDock({ state, dispatch, sock }: { state: State; dispatch: Dispatch; sock: Sock }) {
  const files = state.activeId ? state.git[state.activeId] ?? [] : [];
  return (
    <div className={`left-dock ${state.leftOpen ? "" : "collapsed"}`}>
      <div className="dock-section-title">worktrees</div>
      {state.worktrees.map((w, i) => (
        <button
          key={w.worktree.id}
          className={`wt-item ${w.worktree.id === state.activeId ? "active" : ""}`}
          onClick={() => dispatch({ a: "activate", id: w.worktree.id })}
          title={`⌘${i + 1} · ${w.worktree.branch}`}
        >
          <span className={`dot ${dotClass(w)}`} />
          <span className="branch">{w.worktree.title}</span>
        </button>
      ))}
      <button className="new-wt" onClick={() => dispatch({ a: "show-prompt", v: true })}>
        + new worktree ⌘K
      </button>

      {files.length > 0 && (
        <>
          <div className="dock-section-title">changes · {files.length}</div>
          {files.map((f) => (
            <button
              key={f.path}
              className="git-file"
              onClick={() =>
                state.activeId && sock?.send({ t: "file-diff", worktreeId: state.activeId, path: f.path })
              }
            >
              <span className={`xy ${xyClass(f.xy)}`}>{f.xy.trim() || "·"}</span>
              <span className="path">{f.path}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function dotClass(w: WorktreeStatus): string {
  if (w.agent === "working") return "working";
  if (w.procs.some((p) => p.status === "crashed")) return "crashed";
  if (w.procs.some((p) => p.status === "running")) return "running";
  if (w.procs.some((p) => p.status === "starting")) return "starting";
  return "idle";
}

function xyClass(xy: string): string {
  if (xy.includes("A") || xy === "??") return "added";
  if (xy.includes("D")) return "deleted";
  return "";
}

function Center({ state, active, dispatch, sock, repo }: {
  state: State; active: WorktreeStatus | null; dispatch: Dispatch; sock: Sock;
  repo: State["repos"][number] | null;
}) {
  // one persistent iframe per visited worktree: switching is a display toggle
  // (instant, and each preview keeps its app state + HMR socket while hidden)
  const [mounted, setMounted] = useState<string[]>([]);
  const activeReady =
    active && active.procs.length > 0 && active.procs.some((p) => p.status !== "stopped");
  useEffect(() => {
    if (active && activeReady && !mounted.includes(active.worktree.id)) {
      setMounted((m) => [...m, active.worktree.id]);
    }
  }, [active?.worktree.id, activeReady]);

  const logs = active ? state.logs[active.worktree.id] ?? [] : [];
  const frames = state.worktrees.filter((w) => mounted.includes(w.worktree.id));

  return (
    <div className="center">
      {frames.map((w) => (
        <iframe
          key={w.worktree.id}
          src={`http://127.0.0.1:${w.worktree.proxyPort}/`}
          title={w.worktree.title}
          style={{ display: w.worktree.id === state.activeId && !state.diff ? "block" : "none" }}
        />
      ))}
      {!activeReady && !state.diff && (
        <div className="empty">
          {!state.connected
            ? "connecting to daemon…"
            : !active
              ? "no worktrees yet — run `orchardist` inside a git repo"
              : logs.length > 0
                ? logs.slice(-20).join("\n")
                : "starting dev servers…"}
        </div>
      )}
      {state.diff && <DiffView diff={state.diff} dispatch={dispatch} />}
      {state.showPrompt && repo && (
        <PromptOverlay
          onSubmit={(text) => {
            sock?.send({ t: "create-worktree", repoId: repo.id, prompt: text });
            dispatch({ a: "show-prompt", v: false });
          }}
          onClose={() => dispatch({ a: "show-prompt", v: false })}
        />
      )}
    </div>
  );
}

function DiffView({ diff, dispatch }: { diff: NonNullable<State["diff"]>; dispatch: Dispatch }) {
  const lines =
    diff.before === "" && diff.after === ""
      ? [{ kind: "hunk" as const, text: "@@ file is empty or could not be read @@" }]
      : lineDiff(diff.before, diff.after);
  return (
    <div className="diff-view" style={{ position: "absolute", inset: 0, background: "var(--bg0)" }}>
      <div className="file-head">
        <span>{diff.path}</span>
        <button onClick={() => dispatch({ a: "close-diff" })}>esc ✕</button>
      </div>
      {lines.map((l, i) => (
        <div key={i} className={`diff-line ${l.kind}`}>
          {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
          {l.text}
        </div>
      ))}
    </div>
  );
}

function PromptOverlay({ onSubmit, onClose }: { onSubmit: (t: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  return (
    <div className="prompt-overlay" onClick={onClose}>
      <div className="prompt-box" onClick={(e) => e.stopPropagation()}>
        <div className="title">new worktree — describe the change; an agent starts on it immediately</div>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && text.trim()) {
              e.preventDefault();
              onSubmit(text.trim());
            }
          }}
          placeholder="make the header sticky and add a dark mode toggle"
        />
      </div>
    </div>
  );
}

function RightDock({ state, active, sock }: { state: State; active: WorktreeStatus | null; sock: Sock }) {
  const items = active ? state.chats[active.worktree.id] ?? [] : [];
  const logRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");

  // pin to bottom while streaming
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  const send = () => {
    if (!active || !text.trim()) return;
    sock?.send({ t: "chat", worktreeId: active.worktree.id, text: text.trim() });
    setText("");
  };

  return (
    <div className={`right-dock ${state.rightOpen ? "" : "collapsed"}`}>
      <div className="chat-log" ref={logRef}>
        {items.map((item, i) => (
          <ChatItemView key={i} item={item} />
        ))}
        {active?.agent === "working" && <div className="msg-thinking">working…</div>}
      </div>
      <div className="chat-input">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={active ? `message agent on ${active.worktree.title}…` : "no worktree selected"}
          disabled={!active}
        />
        <div className="chat-hint">enter to send · shift+enter newline · ⌘K new worktree</div>
      </div>
    </div>
  );
}

function ChatItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return <div className="msg-user">{item.text}</div>;
    case "assistant":
      return <div className="msg-assistant">{item.text}</div>;
    case "thinking":
      return <div className="msg-thinking">{item.text}</div>;
    case "error":
      return <div className="msg-assistant" style={{ color: "var(--red)" }}>{item.text}</div>;
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
}

function toolHint(item: Extract<ChatItem, { kind: "tool" }>): string {
  const input = item.input as Record<string, unknown> | null;
  if (!input) return "";
  const v = input["file_path"] ?? input["command"] ?? input["path"] ?? input["pattern"] ?? "";
  return typeof v === "string" ? v : "";
}

function StatusBar({ state, active, dispatch }: { state: State; active: WorktreeStatus | null; dispatch: Dispatch }) {
  return (
    <div className="status-bar">
      <button className={`toggle ${state.leftOpen ? "on" : ""}`} onClick={() => dispatch({ a: "toggle-left" })}>
        ⌘B docks
      </button>
      <button className={`toggle ${state.rightOpen ? "on" : ""}`} onClick={() => dispatch({ a: "toggle-right" })}>
        ⌘J chat
      </button>
      <span className="grow" />
      {active && (
        <>
          <span className="branch">{active.worktree.branch}</span>
          {active.procs.map((p) => (
            <span key={p.name} className="proc">
              <span className={`dot ${p.status === "running" ? "running" : p.status === "crashed" ? "crashed" : "starting"}`} />
              {p.name}:{p.port}
            </span>
          ))}
        </>
      )}
      <span>{state.connected ? "connected" : "reconnecting…"}</span>
    </div>
  );
}
