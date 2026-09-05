import { Suspense, lazy, useEffect, useReducer, useRef, useState } from "react";
import type { WorktreeStatus } from "@orchardist/shared";
import { DaemonSocket } from "./ws.ts";
import { initial, reducer, type ChatItem, type State } from "./store.ts";

const MonacoDiff = lazy(() => import("./MonacoDiff.tsx"));

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

  // ship results: open PR/compare URLs, auto-dismiss toasts
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    const toast = state.toast;
    if (!toast) return;
    if (toast.ok && toast.url && openedRef.current !== toast.url) {
      openedRef.current = toast.url;
      window.open(toast.url, "_blank");
    }
    const timer = setTimeout(() => dispatch({ a: "dismiss-toast" }), toast.ok ? 5000 : 12000);
    return () => clearTimeout(timer);
  }, [state.toast]);

  const repo = state.repos[0] ?? null;

  return (
    <div className="app">
      <div className="docks">
        <LeftDock state={state} dispatch={dispatch} sock={sock} />
        <Center state={state} active={active} dispatch={dispatch} sock={sock} repo={repo} />
        <RightDock state={state} active={active} sock={sock} dispatch={dispatch} />
      </div>
      <StatusBar state={state} active={active} dispatch={dispatch} />
      {state.toast && (
        <div className={`toast ${state.toast.ok ? "ok" : "err"}`} onClick={() => dispatch({ a: "dismiss-toast" })}>
          {state.toast.message}
          {state.toast.removeId && (
            <button
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                sockRef.current?.send({ t: "remove-worktree", worktreeId: state.toast!.removeId! });
                dispatch({ a: "dismiss-toast" });
              }}
            >
              remove worktree
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Sock = DaemonSocket | null;
type Dispatch = (a: Parameters<typeof reducer>[1]) => void;

function LeftDock({ state, dispatch, sock }: { state: State; dispatch: Dispatch; sock: Sock }) {
  const gitInfo = state.activeId ? state.git[state.activeId] : undefined;
  const files = gitInfo?.files ?? [];
  const ahead = gitInfo?.ahead ?? 0;
  const behind = gitInfo?.behind ?? 0;
  const active = state.worktrees.find((w) => w.worktree.id === state.activeId) ?? null;
  const isWt = active && active.worktree.kind !== "main";
  const landable = isWt && (files.length > 0 || ahead > 0);
  return (
    <div className={`left-dock ${state.leftOpen ? "" : "collapsed"}`}>
      <div className="dock-section-title changes-head">
        <span>
          changes{files.length > 0 ? ` · ${files.length}` : ""}
          {ahead > 0 && <span className="ahead-badge" title={`${ahead} commit(s) ahead of main`}> ↑{ahead}</span>}
          {behind > 0 && <span className="behind-badge" title={`${behind} commit(s) behind main`}> ↓{behind}</span>}
        </span>
        {landable && (
          <span className="land-btns">
            <button
              className="ship-btn"
              title="Commit and merge into main locally (no push)"
              onClick={() => sock?.send({ t: "merge-main", worktreeId: active.worktree.id })}
            >
              merge
            </button>
            <button
              className="ship-btn"
              title="Commit, push, open a PR"
              onClick={() => sock?.send({ t: "ship", worktreeId: active.worktree.id })}
            >
              pr ↗
            </button>
          </span>
        )}
      </div>
      {files.length === 0 && <div className="dock-empty">no changes on {active?.worktree.title ?? "—"}</div>}
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
    </div>
  );
}

function WtSwitcher({ state, dispatch, sock }: { state: State; dispatch: Dispatch; sock: Sock }) {
  const [open, setOpen] = useState(true);
  const active = state.worktrees.find((w) => w.worktree.id === state.activeId) ?? null;

  const rename = (w: WorktreeStatus) => {
    if (w.worktree.kind === "main") return;
    const title = window.prompt("Rename worktree (also renames its branch):", w.worktree.title);
    if (title && title.trim()) {
      sock?.send({ t: "rename-worktree", worktreeId: w.worktree.id, title: title.trim() });
    }
  };

  return (
    <div className="wt-switcher">
      <button className="wt-current" onClick={() => setOpen(!open)} title="Switch worktree (⌘1–9)">
        {open ? (
          <span className="branch helper">worktrees · {state.worktrees.length}</span>
        ) : active ? (
          <>
            <span className={`dot ${dotClass(active)}`} />
            <span className="branch">{active.worktree.title}</span>
          </>
        ) : (
          <span className="branch">no worktree</span>
        )}
        <span className={`chevron ${open ? "up" : ""}`}>▾</span>
      </button>
      {open && (
        <div className="wt-list">
          {state.worktrees.map((w, i) => (
            <button
              key={w.worktree.id}
              className={`wt-item ${w.worktree.id === state.activeId ? "active" : ""}`}
              onClick={() => dispatch({ a: "activate", id: w.worktree.id })}
              onDoubleClick={() => rename(w)}
              title={`⌘${i + 1} · ${w.worktree.branch} · double-click to rename`}
            >
              <span className={`dot ${dotClass(w)}`} />
              <span className="branch">{w.worktree.title}</span>
            </button>
          ))}
          <button className="new-wt" onClick={() => dispatch({ a: "show-prompt", v: true })}>
            + new worktree ⌘K
          </button>
        </div>
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
      {state.diff && <DiffView diff={state.diff} state={state} dispatch={dispatch} />}
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

function DiffView({ diff, state, dispatch }: {
  diff: NonNullable<State["diff"]>; state: State; dispatch: Dispatch;
}) {
  const wt = state.worktrees.find((w) => w.worktree.id === diff.worktreeId);
  const absPath = wt ? `${wt.worktree.path}/${diff.path}` : diff.path;
  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg0)" }}>
      <div className="file-head" style={{ padding: "6px 16px", display: "flex", gap: 12 }}>
        <span style={{ flex: 1, font: "12px var(--font-mono)", color: "var(--fg-muted)" }}>{diff.path}</span>
        <a className="deep-link" href={`zed://file${absPath}`} title="Open in Zed">zed</a>
        <a className="deep-link" href={`vscode://file${absPath}`} title="Open in VS Code">code</a>
        <a className="deep-link" href={`cursor://file${absPath}`} title="Open in Cursor">cursor</a>
        <button onClick={() => dispatch({ a: "close-diff" })} title="Close (esc)">✕</button>
      </div>
      <Suspense fallback={<div className="empty">loading diff…</div>}>
        <MonacoDiff before={diff.before} after={diff.after} path={diff.path} />
      </Suspense>
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

function RightDock({ state, active, sock, dispatch }: { state: State; active: WorktreeStatus | null; sock: Sock; dispatch: Dispatch }) {
  const items = active ? state.chats[active.worktree.id] ?? [] : [];
  const logRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");

  // spawn-a-worktree default: on for main (protect the working copy),
  // off on worktrees (continue that conversation); user can override per tab
  const isMain = active?.worktree.kind === "main";
  const [spawnNew, setSpawnNew] = useState(isMain);
  useEffect(() => setSpawnNew(active?.worktree.kind === "main"), [active?.worktree.id]);

  // pin to bottom while streaming
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  const send = () => {
    if (!active || !text.trim()) return;
    if (spawnNew) {
      sock?.send({
        t: "create-worktree",
        repoId: active.worktree.repoId,
        prompt: text.trim(),
        baseWorktreeId: active.worktree.id,
      });
    } else {
      sock?.send({ t: "chat", worktreeId: active.worktree.id, text: text.trim() });
    }
    setText("");
  };

  return (
    <div className={`right-dock ${state.rightOpen ? "" : "collapsed"}`}>
      <WtSwitcher state={state} dispatch={dispatch} sock={sock} />
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
          placeholder={
            !active
              ? "no worktree selected"
              : spawnNew
                ? "describe a change — starts an agent in a new worktree…"
                : `message agent on ${active.worktree.title}…`
          }
          disabled={!active}
        />
        <div className="chat-hint spawn-row">
          <label title={isMain ? "Unchecked: the agent edits your main working copy directly" : "Checked: fork a new worktree from this one instead of continuing here"}>
            <input type="checkbox" checked={spawnNew} onChange={(e) => setSpawnNew(e.target.checked)} />
            <span>
              new worktree from <b>{active?.worktree.title ?? "—"}</b>
            </span>
          </label>
        </div>
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

function PanelIcon({ side, filled }: { side: "left" | "right"; filled: boolean }) {
  const bar = side === "left" ? { x: 1.5, width: 4.5 } : { x: 10, width: 4.5 };
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {filled && <rect {...bar} y="3.7" height="8.6" rx="0.8" fill="currentColor" opacity="0.75" />}
      {!filled && <line x1={side === "left" ? 6 : 10} y1="3" x2={side === "left" ? 6 : 10} y2="13" stroke="currentColor" strokeWidth="1.2" />}
    </svg>
  );
}

function StatusBar({ state, active, dispatch }: { state: State; active: WorktreeStatus | null; dispatch: Dispatch }) {
  return (
    <div className="status-bar">
      <button
        className={`toggle icon ${state.leftOpen ? "on" : ""}`}
        onClick={() => dispatch({ a: "toggle-left" })}
        title="Toggle worktrees panel (⌘B)"
      >
        <PanelIcon side="left" filled={state.leftOpen} />
      </button>
      <button
        className={`toggle icon ${state.rightOpen ? "on" : ""}`}
        onClick={() => dispatch({ a: "toggle-right" })}
        title="Toggle chat panel (⌘J)"
      >
        <PanelIcon side="right" filled={state.rightOpen} />
      </button>
      <span className="grow" />
      {active && (
        <>
          <span className="branch">{active.worktree.branch}</span>
          {active.procs.map((p) => (
            <span
              key={p.name}
              className="proc"
              title={`${p.command} — ${p.status} on :${p.port}`}
            >
              <span className={`dot ${p.status === "running" ? "running" : p.status === "crashed" ? "crashed" : "starting"}`} />
              {p.name}
            </span>
          ))}
        </>
      )}
      <span title={state.connected ? "Connected to daemon" : "Reconnecting to daemon"}>
        {state.connected ? "●" : "○"}
      </span>
    </div>
  );
}
