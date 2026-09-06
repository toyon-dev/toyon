import { Suspense, lazy, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { GitFileStatus, RepoInfo, SearchHit, WorktreeStatus } from "@orchardist/shared";
import { DaemonSocket, hasToken } from "./ws.ts";
import { initial, reducer, type ChatItem, type State } from "./store.ts";
import { Tooltips, tip } from "./Tooltip.tsx";

const MonacoDiff = lazy(() => import("./MonacoDiff.tsx"));

// Preview iframes hit the worktree's proxy port. Locally that is always
// loopback (the daemon binds 127.0.0.1); in cloud mode the same port is a
// public TLS port on the host that served this page, so follow the page's origin.
function previewUrl(proxyPort: number): string {
  const h = location.hostname;
  const local = h === "127.0.0.1" || h === "localhost" || h.endsWith(".localhost");
  if (local) return `http://127.0.0.1:${proxyPort}/`;
  return `${location.protocol}//${h}:${proxyPort}/`;
}

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

  // window/app title follows the active worktree
  useEffect(() => {
    document.title = active ? `${active.worktree.title} — orchardist` : "orchardist";
  }, [active?.worktree.title]);

  // remember the selection across reloads
  useEffect(() => {
    if (state.activeId) {
      try {
        localStorage.setItem("orch-active", state.activeId);
      } catch {}
    }
  }, [state.activeId]);

  // keyboard: cmd+1..9 switch tabs; every other chord toggles its panel (cmd+k prompt, cmd+p jump, cmd+b/j docks…); esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key >= "1" && e.key <= "9") {
        // ⌘9 always lands on the last worktree (macOS tab convention), whatever the count
        const n = Number(e.key);
        const wt = n === 9 ? state.worktrees[state.worktrees.length - 1] : state.worktrees[n - 1];
        if (wt) { e.preventDefault(); dispatch({ a: "activate", id: wt.worktree.id }); }
      } else if (e.metaKey && e.key === "k") {
        e.preventDefault();
        dispatch({ a: "show-prompt", v: !state.showPrompt });
      } else if (e.metaKey && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        if (state.showQuickOpen) {
          dispatch({ a: "quick-open", v: false });
        } else if (state.activeId) {
          sockRef.current?.send({ t: "list-files", worktreeId: state.activeId });
          dispatch({ a: "quick-open", v: true });
        }
      } else if (e.metaKey && !e.shiftKey && e.key === "e") {
        e.preventDefault();
        if (state.picking) {
          if (state.activeId) previewBus.post(state.activeId, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        } else if (state.activeId) {
          previewBus.post(state.activeId, { type: "pick-start" });
          dispatch({ a: "set-picking", v: true });
        }
      } else if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (state.activeId) dispatch({ a: "show-search", v: !state.showSearch });
      } else if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "e") {
        // editors use ⌘⇧P, but Firefox/Edge own it (new private window) and browsers handle
        // that before the page sees it — ⌘⇧E is unbound everywhere
        e.preventDefault();
        dispatch({ a: "show-commands", v: !state.showCommands });
      } else if (e.metaKey && e.key === ".") {
        e.preventDefault();
        dispatch({ a: "toggle-zen" });
      } else if (e.metaKey && e.key === "b") {
        e.preventDefault();
        dispatch({ a: "toggle-left" });
      } else if (e.metaKey && e.key === "j") {
        e.preventDefault();
        dispatch({ a: "toggle-right" });
      } else if (e.metaKey && e.key === "/") {
        e.preventDefault();
        dispatch({ a: "show-keys", v: !state.showKeys });
      } else if (e.key === "Escape") {
        if (state.showKeys) dispatch({ a: "show-keys", v: false });
        else if (state.picking) {
          // (the bridge handles esc itself when the preview has focus; this covers focus in the shell)
          if (state.activeId) previewBus.post(state.activeId, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        } else if (state.zen) dispatch({ a: "toggle-zen" });
        else if (state.showQuickOpen) dispatch({ a: "quick-open", v: false });
        else if (state.showSearch) dispatch({ a: "show-search", v: false });
        else if (state.showCommands) dispatch({ a: "show-commands", v: false });
        else if (state.showPrompt) dispatch({ a: "show-prompt", v: false });
        else if (state.diff) dispatch({ a: "close-diff" });
      }
    };
    window.addEventListener("keydown", onKey);
    // (⌘E arrives from the iframe too, via the bridge chord forwarding)
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (d && d.__orchardist && d.type === "key" && d.meta) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: d.key, metaKey: true, shiftKey: !!d.shift }));
      }
    };
    window.addEventListener("message", onMsg);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMsg);
    };
  }, [state.worktrees, state.diff, state.showPrompt, state.showQuickOpen, state.showSearch, state.showCommands, state.activeId, state.picking, state.zen, state.showKeys]);

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

  // far-right worktree rail: 40px dot strip, hover peeks the full panel

  // route follows you across variant siblings: comparing the same screen is
  // the whole point of variants, so switching carries the current path over
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = prevActiveRef.current;
    prevActiveRef.current = state.activeId;
    if (!prevId || !state.activeId || prevId === state.activeId) return;
    const prev = state.worktrees.find((w) => w.worktree.id === prevId);
    const next = state.worktrees.find((w) => w.worktree.id === state.activeId);
    const g = prev?.worktree.variant?.group;
    if (!g || next?.worktree.variant?.group !== g) return;
    const pathOf = (id: string) => {
      try {
        const u = state.pageCtx[id]?.url;
        return u ? new URL(u).pathname + new URL(u).search : "/";
      } catch {
        return "/";
      }
    };
    const from = pathOf(prevId);
    if (from !== pathOf(state.activeId)) {
      previewBus.post(state.activeId, { type: "navigate", path: from });
    }
  }, [state.activeId]);

  // resizable docks, widths persisted per browser
  const [leftW, setLeftW] = useState(() => clampW(Number(localStorage.getItem("orch-lw")), 220));
  const [rightW, setRightW] = useState(() => clampW(Number(localStorage.getItem("orch-rw")), 380));
  const railPx = 40;
  const startDrag = (side: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const handle = e.currentTarget;
    handle.classList.add("active");
    const move = (ev: PointerEvent) => {
      if (side === "left") {
        const w = clampW(ev.clientX, 220);
        setLeftW(w);
        localStorage.setItem("orch-lw", String(w));
      } else {
        // the worktree rail sits between the chat dock and the window edge
        const w = clampW(window.innerWidth - railPx - ev.clientX, 380);
        setRightW(w);
        localStorage.setItem("orch-rw", String(w));
      }
    };
    const up = () => {
      document.body.classList.remove("resizing");
      handle.classList.remove("active");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // nav cluster stays centered over the preview column
  const [winW, setWinW] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // (resize handles are zero-width in layout — nothing to add for them)
  const leftPx = state.leftOpen ? leftW : 0;
  const rightPx = (state.rightOpen ? rightW : 0) + railPx;
  const navCenter = leftPx + (winW - leftPx - rightPx) / 2;

  return (
    <div className={`app ${state.zen ? "zen" : ""}`}>
      <Tooltips />
      <StatusBar state={state} active={active} dispatch={dispatch} sock={sock} navCenter={navCenter} />
      <div className="docks">
        <LeftDock state={state} dispatch={dispatch} sock={sock} width={leftW} />
        {state.leftOpen && <div className="dock-resize left" onPointerDown={startDrag("left")} />}
        <Center state={state} active={active} dispatch={dispatch} sock={sock} repo={repo} />
        {state.rightOpen && <div className="dock-resize right" onPointerDown={startDrag("right")} />}
        <RightDock state={state} active={active} sock={sock} dispatch={dispatch} width={rightW} />
        <WtRail state={state} dispatch={dispatch} sock={sock} />
      </div>
      {state.toast && (
        <div className={`toast ${state.toast.ok ? "ok" : "err"}`} onClick={() => dispatch({ a: "dismiss-toast" })}>
          {state.toast.message}
          {state.toast.removeIds && state.toast.removeIds.length > 0 && (
            <button
              className="toast-action"
              onClick={(e) => {
                e.stopPropagation();
                for (const id of state.toast!.removeIds!) {
                  sockRef.current?.send({ t: "remove-worktree", worktreeId: id });
                }
                dispatch({ a: "dismiss-toast" });
              }}
            >
              {state.toast.removeIds.length > 1
                ? `clean up ${state.toast.removeIds.length} worktrees`
                : "remove worktree"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type Sock = DaemonSocket | null;
type Dispatch = (a: Parameters<typeof reducer>[1]) => void;

// module-level bridge to post into preview iframes (registered by Center)
export const previewBus = {
  post: (_id: string, _msg: Record<string, unknown>) => {},
};

// fiber lineNumbers may be preamble-shifted (daemon derives the offset per file)
function shiftRanges(cr: { ranges: Array<[number, number]>; offset: number }): Array<[number, number]> {
  return cr.ranges.map(([a, b]) => [a + cr.offset, b + cr.offset]);
}

function relFile(file: string, worktreePath?: string): string {
  if (worktreePath && file.startsWith(worktreePath + "/")) return file.slice(worktreePath.length + 1);
  const i = file.lastIndexOf("/src/");
  return i >= 0 ? file.slice(i + 1) : file;
}

function clampW(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 170), Math.floor(window.innerWidth * 0.5));
}

function LeftDock({ state, dispatch, sock, width }: { state: State; dispatch: Dispatch; sock: Sock; width: number }) {
  const gitInfo = state.activeId ? state.git[state.activeId] : undefined;
  const files = gitInfo?.files ?? [];
  const ahead = gitInfo?.ahead ?? 0;
  const behind = gitInfo?.behind ?? 0;
  const active = state.worktrees.find((w) => w.worktree.id === state.activeId) ?? null;
  const isWt = active && active.worktree.kind !== "main";
  const clean = files.length === 0;
  const [commitMsg, setCommitMsg] = useState("");
  useEffect(() => setCommitMsg(""), [state.activeId]);

  const commit = () => {
    if (!active || !commitMsg.trim()) return;
    sock?.send({ t: "commit", worktreeId: active.worktree.id, message: commitMsg.trim() });
    setCommitMsg("");
  };

  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string; canDiscard: boolean } | null>(null);
  useEffect(() => {
    if (!fileMenu) return;
    const close = () => setFileMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [fileMenu]);

  const fileCtx = (e: React.MouseEvent, path: string, canDiscard: boolean) => {
    e.preventDefault();
    setFileMenu({ x: e.clientX, y: e.clientY, path, canDiscard });
  };

  // hover a changed file -> highlight only its changed lines' elements
  const hoverPathRef = useRef<string | null>(null);
  const hoverFile = (path: string, entering: boolean) => {
    if (!state.activeId) return;
    if (!entering) {
      hoverPathRef.current = null;
      previewBus.post(state.activeId, { type: "highlight-clear" });
      return;
    }
    hoverPathRef.current = path;
    const cached = state.changedRanges[`${state.activeId}:${path}`];
    if (cached) {
      previewBus.post(state.activeId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
    } else {
      sock?.send({ t: "changed-ranges", worktreeId: state.activeId, path });
    }
  };
  useEffect(() => {
    const path = hoverPathRef.current;
    if (!path || !state.activeId) return;
    const cached = state.changedRanges[`${state.activeId}:${path}`];
    if (cached) previewBus.post(state.activeId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
  }, [state.changedRanges]);

  return (
    <div className={`left-dock ${state.leftOpen ? "" : "collapsed"}`} style={{ width }}>
      {(behind > 0 || ahead > 0 || active?.worktree.landed) && (
        <div className="dock-section-title changes-head">
          <span>
            {behind > 0 && <span className="behind-badge" data-tip={`${behind} commit(s) behind main`}>↓{behind} </span>}
            {ahead > 0 && <span className="ahead-badge" data-tip={`${ahead} commit(s) ahead of main`}>↑{ahead} </span>}
            {active?.worktree.landed && <span className="landed-badge" data-tip="Merged into main">✓ landed</span>}
          </span>
          {isWt && clean && (behind > 0 || ahead > 0) && (
            <span className="land-btns">
              {behind > 0 && (
                <button
                  className="ship-btn"
                  data-tip={`Pull ${behind} commit(s) from main into this worktree`}
                  onClick={() => sock?.send({ t: "sync-main", worktreeId: active.worktree.id })}
                >
                  sync ↓
                </button>
              )}
              {ahead > 0 && (
                <>
                  <button
                    className="ship-btn"
                    data-tip={
                      active.worktree.prUrl
                        ? "Merge locally — the open PR will show as merged once main is pushed"
                        : "Merge into main locally (no push)"
                    }
                    onClick={() => sock?.send({ t: "merge-main", worktreeId: active.worktree.id })}
                  >
                    merge
                  </button>
                  {active.worktree.prUrl ? (
                    <button
                      className="ship-btn pr-open"
                      data-tip={`PR open — click to view · ${active.worktree.prUrl}`}
                      onClick={() => window.open(active.worktree.prUrl, "_blank")}
                    >
                      pr open ↗
                    </button>
                  ) : (
                    <button
                      className="ship-btn"
                      data-tip="Push and open a PR"
                      onClick={() => sock?.send({ t: "ship", worktreeId: active.worktree.id })}
                    >
                      pr ↗
                    </button>
                  )}
                </>
              )}
            </span>
          )}
        </div>
      )}
      {files.length > 0 && (
        <>
          <div className="dock-section-title">uncommitted · {files.length}</div>
          {files.map((f) => (
            <button
              key={f.path}
              className="git-file"
              onClick={() =>
                state.activeId && sock?.send({ t: "file-diff", worktreeId: state.activeId, path: f.path })
              }
              onContextMenu={(e) => fileCtx(e, f.path, true)}
              onMouseEnter={() => hoverFile(f.path, true)}
              onMouseLeave={() => hoverFile(f.path, false)}
            >
              <span className={`xy ${xyClass(f.xy)}`}>{xyLetter(f.xy)}</span>
              <span className="path">{f.path}</span>
              <LineCounts f={f} />
            </button>
          ))}
          <div className="commit-box">
            <input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              placeholder="commit message…"
            />
            <button className="ship-btn" disabled={!commitMsg.trim()} onClick={commit} data-tip="git add -A && git commit">
              commit
            </button>
          </div>
        </>
      )}
      {(gitInfo?.committed?.length ?? 0) > 0 && (
        <>
          <div className="dock-section-title" data-tip="Committed on this branch, not yet on main">
            committed · {gitInfo!.committed!.length}
          </div>
          {gitInfo!.committed!.map((f) => (
            <button
              key={`c-${f.path}`}
              className="git-file"
              onClick={() =>
                state.activeId && sock?.send({ t: "file-diff", worktreeId: state.activeId, path: f.path })
              }
              onContextMenu={(e) => fileCtx(e, f.path, false)}
              onMouseEnter={() => hoverFile(f.path, true)}
              onMouseLeave={() => hoverFile(f.path, false)}
            >
              <span className={`xy ${xyClass(f.xy)}`}>{xyLetter(f.xy)}</span>
              <span className="path">{f.path}</span>
              <LineCounts f={f} />
            </button>
          ))}
        </>
      )}
      {clean && (gitInfo?.committed?.length ?? 0) === 0 && <div className="dock-empty">clean</div>}
      {fileMenu && active && (
        <div className="ctx-menu" style={{ left: fileMenu.x, top: fileMenu.y }}>
          {EDITORS.map((ed) => (
            <button
              key={ed.scheme}
              onClick={() => {
                window.location.href = `${ed.scheme}://file${active.worktree.path}/${fileMenu.path}`;
              }}
            >
              open in {ed.label}
            </button>
          ))}
          <button
            onClick={() => sock?.send({ t: "reveal", worktreeId: active.worktree.id, path: fileMenu.path })}
          >
            reveal in Finder
          </button>
          {fileMenu.canDiscard && (
            <button
              className="danger"
              onClick={() => {
                if (window.confirm(`Discard uncommitted changes to ${fileMenu.path}?`)) {
                  sock?.send({ t: "discard-file", worktreeId: active.worktree.id, path: fileMenu.path });
                }
              }}
            >
              discard changes…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WtRail({ state, dispatch, sock }: {
  state: State; dispatch: Dispatch; sock: Sock;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; land?: boolean } | null>(null);
  const [graftMode, setGraftMode] = useState(false);
  const [sel, setSel] = useState<string[]>([]);

  const toggleSel = (w: WorktreeStatus) => {
    if (w.worktree.kind === "main") return;
    setGraftMode(true);
    setSel((s) =>
      s.includes(w.worktree.id) ? s.filter((x) => x !== w.worktree.id) : [...s, w.worktree.id],
    );
  };

  const cancelGraft = () => {
    setGraftMode(false);
    setSel([]);
  };

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && cancelGraft();
    if (graftMode) window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [graftMode]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    // clicks inside the preview iframe never bubble here, but they do steal focus
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const { rename, pickVariant, remove } = wtActions(sock);

  const menuWt = menu ? state.worktrees.find((w) => w.worktree.id === menu.id) ?? null : null;

  return (
    <div className={`wt-rail ${graftMode || menu ? "hold" : ""} ${state.connected ? "" : "offline"}`}>
      <div className="rail-panel">
      {(
        <div className="rail-list">
          {state.worktrees.map((w, i) => (
            <button
              key={w.worktree.id}
              className={`wt-item ${w.worktree.id === state.activeId ? "active" : ""} ${sel.includes(w.worktree.id) ? "sel" : ""} ${menu?.id === w.worktree.id ? "menu-open" : ""}`}
              onClick={(e) => {
                if (graftMode || e.shiftKey) toggleSel(w);
                else dispatch({ a: "activate", id: w.worktree.id });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: w.worktree.id });
              }}
            >
              {graftMode && w.worktree.kind !== "main" && (
                <input
                  type="checkbox"
                  className="graft-check"
                  checked={sel.includes(w.worktree.id)}
                  readOnly
                  tabIndex={-1}
                />
              )}
              <span className={`dot ${dotClass(w)}`} />
              <span className="branch">
                {w.worktree.kind === "combined" ? "⧉ " : ""}
                {w.worktree.title}
              </span>
              {w.worktree.variant && (
                <span
                  className="row-badge variant-badge clickable"
                  data-tip="Keep this variant, remove the others"
                  onClick={(e) => {
                    e.stopPropagation();
                    pickVariant(w);
                  }}
                >
                  <span className="num">v{w.worktree.variant.index}/{w.worktree.variant.of}</span>
                  <span className="act">pick</span>
                </span>
              )}
              {(w.dirty ?? 0) > 0 && (
                <span
                  className="row-badge dirty-badge clickable"
                  data-tip="View changes"
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch({ a: "activate", id: w.worktree.id });
                    if (!state.leftOpen) dispatch({ a: "toggle-left" });
                  }}
                >
                  <span className="num">~{w.dirty}</span>
                  <span className="act">view</span>
                </span>
              )}
              {(w.behind ?? 0) > 0 && (
                <span
                  className="row-badge behind-badge clickable"
                  data-tip="Sync from main"
                  onClick={(e) => {
                    e.stopPropagation();
                    sock?.send({ t: "sync-main", worktreeId: w.worktree.id });
                  }}
                >
                  <span className="num">↓{w.behind}</span>
                  <span className="act">sync</span>
                </span>
              )}
              {(w.ahead ?? 0) > 0 && (
                <span
                  className="row-badge ahead-badge clickable"
                  data-tip="Land"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.target as HTMLElement).getBoundingClientRect();
                    setMenu({ x: r.left - 100, y: r.bottom + 4, id: w.worktree.id, land: true });
                  }}
                >
                  <span className="num">↑{w.ahead}</span>
                  <span className="act">land</span>
                </span>
              )}
              <span
                className="wt-more"
                {...tip("Actions")}
                onClick={(e) => {
                  e.stopPropagation();
                  const r = (e.target as HTMLElement).getBoundingClientRect();
                  setMenu({ x: r.left - 140, y: r.bottom + 4, id: w.worktree.id });
                }}
              >
                ⋯
              </span>
            </button>
          ))}
          {graftMode && (
            <div className="graft-row">
              <button
                className="bulk-btn combine-btn"
                disabled={sel.length < 2}
                data-tip="Preview these worktrees merged together (local octopus merge)"
                onClick={() => {
                  sock?.send({ t: "combine", worktreeIds: sel });
                  cancelGraft();
                }}
              >
                ⧉ graft {sel.length}
              </button>
              <button
                className="bulk-btn"
                disabled={!sel.some((id) => (state.worktrees.find((w) => w.worktree.id === id)?.behind ?? 0) > 0)}
                data-tip="Pull main into every selected worktree that's behind"
                onClick={() => {
                  for (const id of sel) {
                    const w = state.worktrees.find((x) => x.worktree.id === id);
                    if ((w?.behind ?? 0) > 0) sock?.send({ t: "sync-main", worktreeId: id });
                  }
                  cancelGraft();
                }}
              >
                ↓ sync
              </button>
              <button
                className="bulk-btn danger"
                disabled={sel.length === 0}
                data-tip="Remove all selected worktrees (branches and changes deleted)"
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${sel.length} worktree(s)?\n\nTheir directories and branches are deleted. Unmerged changes are lost.`,
                    )
                  ) {
                    for (const id of sel) sock?.send({ t: "remove-worktree", worktreeId: id });
                    cancelGraft();
                  }
                }}
              >
                remove…
              </button>
              <button className="bulk-btn" {...tip("Cancel", "esc")} onClick={cancelGraft}>
                ✕
              </button>
            </div>
          )}
          {!graftMode && (
            <button className="new-wt" data-tip="New worktree" data-tip-key="⌘K" onClick={() => dispatch({ a: "show-prompt", v: true })}>
              <span className="nw-full">+ new worktree</span>
              <span className="nw-mini">+</span>
              <span className="kbd-hint nw-full">⌘K</span>
            </button>
          )}
        </div>
      )}
      <div
        className={`rail-foot ${state.connected ? "" : "off"}`}
        data-tip={state.connected ? "Connected to daemon" : "Reconnecting to daemon"}
      >
        <span className="nw-full conn-label">{state.connected ? "connected" : "reconnecting…"}</span>
        <span className="conn-dot" />
      </div>
      {menu && menuWt && menu.land && (
        <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 180), top: menu.y }}>
          <button onClick={() => sock?.send({ t: "merge-main", worktreeId: menuWt.worktree.id })}>
            merge into main
          </button>
          <button onClick={() => sock?.send({ t: "ship", worktreeId: menuWt.worktree.id })}>
            push + PR
          </button>
        </div>
      )}
      {menu && menuWt && !menu.land && (
        <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 180), top: menu.y }}>
          {((menuWt.dirty ?? 0) > 0 || (menuWt.ahead ?? 0) > 0 || !state.leftOpen) && (
            <button
              onClick={() => {
                dispatch({ a: "activate", id: menuWt.worktree.id });
                if (!state.leftOpen) dispatch({ a: "toggle-left" });
              }}
            >
              view changes{(menuWt.dirty ?? 0) > 0 ? ` (${menuWt.dirty})` : ""}
            </button>
          )}
          <button onClick={() => sock?.send({ t: "reveal", worktreeId: menuWt.worktree.id })}>
            reveal in Finder
          </button>
          {menuWt.worktree.kind !== "main" ? (
            <>
              <button onClick={() => rename(menuWt)}>rename…</button>
              {menuWt.worktree.variant && (
                <button onClick={() => pickVariant(menuWt)}>
                  keep this variant…
                </button>
              )}
              <button
                onClick={() => {
                  setGraftMode(true);
                  setSel((s) => (s.includes(menuWt.worktree.id) ? s : [...s, menuWt.worktree.id]));
                }}
              >
                graft with…
              </button>
              <button onClick={() => sock?.send({ t: "merge-main", worktreeId: menuWt.worktree.id })}>
                merge into main
              </button>
              <button onClick={() => sock?.send({ t: "ship", worktreeId: menuWt.worktree.id })}>
                push + PR
              </button>
              <button className="danger" onClick={() => remove(menuWt)}>remove…</button>
            </>
          ) : null}
        </div>
      )}
      </div>
    </div>
  );
}

/** confirm-then-send worktree actions, shared by the rail's context menu and the ⌘⇧E palette */
function wtActions(sock: Sock) {
  return {
    rename(w: WorktreeStatus) {
      if (w.worktree.kind === "main") return;
      const title = window.prompt("Rename worktree (also renames its branch):", w.worktree.title);
      if (title && title.trim()) {
        sock?.send({ t: "rename-worktree", worktreeId: w.worktree.id, title: title.trim() });
      }
    },
    pickVariant(w: WorktreeStatus) {
      const v = w.worktree.variant;
      if (!v) return;
      const others = v.of - 1;
      if (window.confirm(`Keep "${w.worktree.title}" and remove ${others} sibling variant(s)? Their branches and changes are deleted.`)) {
        sock?.send({ t: "pick-variant", worktreeId: w.worktree.id });
      }
    },
    remove(w: WorktreeStatus) {
      if (w.worktree.kind === "main") return;
      const ok = window.confirm(
        `Remove worktree "${w.worktree.title}"?\n\nThis deletes its directory and branch (${w.worktree.branch}). Unmerged changes are lost.`,
      );
      if (ok) sock?.send({ t: "remove-worktree", worktreeId: w.worktree.id });
    },
  };
}

type Command = { id: string; label: string; hint?: string; run: () => void };

/** everything the UI can do, as typeable commands — chords first, then the context-menu long tail */
function buildCommands(state: State, dispatch: Dispatch, sock: Sock, active: WorktreeStatus | null, repo: RepoInfo | null): Command[] {
  const cmds: Command[] = [];
  const add = (id: string, label: string, run: () => void, hint?: string) => cmds.push({ id, label, hint, run });
  const wt = active;
  const id = wt?.worktree.id;

  if (repo) add("new", "new worktree…", () => dispatch({ a: "show-prompt", v: true }), "⌘K");
  if (id) {
    add("jump", "jump to file…", () => { sock?.send({ t: "list-files", worktreeId: id }); dispatch({ a: "quick-open", v: true }); }, "⌘P");
    add("search", "search in files…", () => dispatch({ a: "show-search", v: true }), "⌘⇧F");
    add("pick", state.picking ? "cancel element picker" : "pick an element on the page", () => {
      if (state.picking) { previewBus.post(id, { type: "pick-cancel" }); dispatch({ a: "set-picking", v: false }); }
      else { previewBus.post(id, { type: "pick-start" }); dispatch({ a: "set-picking", v: true }); }
    }, "⌘E");
    add("reload", "reload preview", () => previewBus.post(id, { type: "reload" }));
  }
  add("left", `${state.leftOpen ? "hide" : "show"} changes panel`, () => dispatch({ a: "toggle-left" }), "⌘B");
  add("right", `${state.rightOpen ? "hide" : "show"} chat panel`, () => dispatch({ a: "toggle-right" }), "⌘J");
  add("zen", "full-bleed preview", () => dispatch({ a: "toggle-zen" }), "⌘.");
  add("keys", "keyboard shortcuts", () => dispatch({ a: "show-keys", v: true }), "⌘/");

  if (wt && id) {
    const acts = wtActions(sock);
    const t = wt.worktree.title;
    if (wt.agent === "working") add("stop", `stop agent — ${t}`, () => sock?.send({ t: "stop-agent", worktreeId: id }));
    for (const p of wt.procs) add(`restart:${p.name}`, `restart ${p.name} (${p.status})`, () => sock?.send({ t: "restart-proc", worktreeId: id, proc: p.name }));
    add("reveal", `reveal in Finder — ${t}`, () => sock?.send({ t: "reveal", worktreeId: id }));
    if ((wt.behind ?? 0) > 0) add("sync", `sync main into ${t} (${wt.behind} behind)`, () => sock?.send({ t: "sync-main", worktreeId: id }));
    if (wt.worktree.kind !== "main") {
      add("rename", `rename worktree — ${t}…`, () => acts.rename(wt));
      if (wt.worktree.variant) add("keep", `keep this variant — ${t}…`, () => acts.pickVariant(wt));
      add("merge", `merge ${t} into main`, () => sock?.send({ t: "merge-main", worktreeId: id }));
      add("ship", `push + PR — ${t}`, () => sock?.send({ t: "ship", worktreeId: id }));
      add("remove", `remove worktree — ${t}…`, () => acts.remove(wt));
    }
  }
  state.worktrees.forEach((w, i) => {
    if (w.worktree.id === id) return;
    add(`go:${w.worktree.id}`, `switch to ${w.worktree.title}`, () => dispatch({ a: "activate", id: w.worktree.id }), keyHint(i, state.worktrees.length)?.trim());
  });
  return cmds;
}

function filterCommands(commands: Command[], q: string): Command[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return commands;
  const scored: Array<{ c: Command; score: number }> = [];
  for (const c of commands) {
    const s = fuzzyScore(c.label.toLowerCase(), needle);
    if (s > 0) scored.push({ c, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.c);
}

function CommandRow({ c, active, onRun }: { c: Command; active: boolean; onRun: () => void }) {
  return (
    <button className={`qo-item cmd-item ${active ? "active" : ""}`} onClick={onRun}>
      <span className="cmd-label">{c.label}</span>
      {c.hint && <span className="cmd-hint">{c.hint}</span>}
    </button>
  );
}

function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    const f = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(f);
  }, []);
  const results = useMemo(() => filterCommands(commands, q), [q, commands]);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".qo-item.active")?.scrollIntoView({ block: "nearest" });
  }, [idx]);
  const run = (c: Command) => { onClose(); c.run(); };
  return (
    <div className="prompt-overlay" onClick={onClose}>
      <div className="prompt-box quick-open" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter" && results[idx]) { e.preventDefault(); run(results[idx]!); }
          }}
          placeholder="run a command…"
        />
        <div className="qo-list" ref={listRef}>
          {results.map((c, i) => <CommandRow key={c.id} c={c} active={i === idx} onRun={() => run(c)} />)}
          {results.length === 0 && <div className="dock-empty">no matching command</div>}
        </div>
      </div>
    </div>
  );
}

function dotClass(w: WorktreeStatus): string {
  if (w.agent === "working") return "working";
  if (w.worktree.landed) return "landed";
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

/** Porcelain XY → one letter. The tool commits with `add -A`, so staged vs unstaged
 * is not a distinction the user can act on, and untracked is just "new". */
function xyLetter(xy: string): string {
  if (xy === "??") return "A";
  if (xy === "UU" || xy === "AA" || xy === "DD" || xy.includes("U")) return "C";
  const code = xy.trim()[0] ?? "";
  return code === "T" ? "M" : code || "·";
}

function LineCounts({ f }: { f: GitFileStatus }) {
  if (f.add === undefined && f.del === undefined) return null;
  return (
    <span className="counts">
      {f.add ? <span className="add">+{f.add}</span> : null}
      {f.del ? <span className="del">−{f.del}</span> : null}
    </span>
  );
}

function Center({ state, active, dispatch, sock, repo }: {
  state: State; active: WorktreeStatus | null; dispatch: Dispatch; sock: Sock;
  repo: State["repos"][number] | null;
}) {
  // one persistent iframe per visited worktree: switching is a display toggle
  // (instant, and each preview keeps its app state + HMR socket while hidden)
  const [mounted, setMounted] = useState<string[]>([]);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());

  // let the rest of the shell post commands into preview iframes
  useEffect(() => {
    previewBus.post = (id, m) =>
      frameRefs.current.get(id)?.contentWindow?.postMessage({ __orchardist: true, ...m }, "*");
  }, []);

  // attribute bridge messages to their worktree via event.source
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || !d.__orchardist) return;
      for (const [id, frame] of frameRefs.current) {
        if (frame.contentWindow === e.source) {
          if (d.type === "hmr") dispatch({ a: "hmr", id });
          else if (d.type === "loaded") {
            dispatch({ a: "hmr", id });
            dispatch({ a: "page", id, url: d.url, title: d.title, fresh: true });
          } else if (d.type === "highlight-miss") {
            console.warn(
              `[orchardist] highlight miss on ${d.path}: ${d.fileMatched} elements from this file, ` +
              `${d.withSource} elements with source info on page, ranges=${JSON.stringify(d.ranges)}`,
            );
          } else if (d.type === "navigated") dispatch({ a: "page", id, url: d.url });
          else if (d.type === "page-error") {
            const where = d.source ? ` (${relFile(String(d.source))}:${d.line ?? "?"})` : "";
            dispatch({ a: "page", id, error: `${d.message}${where}` });
          } else if (d.type === "picked") {
            dispatch({
              a: "picked",
              pick: {
                worktreeId: id,
                component: d.component ?? null,
                file: d.file ?? null,
                line: d.line ?? null,
                tag: String(d.tag ?? ""),
                classes: String(d.classes ?? ""),
                text: String(d.text ?? ""),
                html: String(d.html ?? ""),
                route: String(d.route ?? ""),
                selector: String(d.selector ?? ""),
              },
            });
          } else if (d.type === "pick-cancel") dispatch({ a: "set-picking", v: false });
          return;
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // agent finished a turn whose changes HMR couldn't cover: reload that preview
  // (small delay so backend --watch/--reload restarts settle first)
  useEffect(() => {
    const req = state.reloadReq;
    if (!req) return;
    const timer = setTimeout(() => {
      frameRefs.current.get(req.id)?.contentWindow?.postMessage({ __orchardist: true, type: "reload" }, "*");
    }, 1200);
    return () => clearTimeout(timer);
  }, [state.reloadReq?.n]);
  const activeReady =
    active && active.procs.length > 0 && active.procs.some((p) => p.status !== "stopped");
  useEffect(() => {
    if (active && activeReady && !mounted.includes(active.worktree.id)) {
      setMounted((m) => [...m, active.worktree.id]);
    }
  }, [active?.worktree.id, activeReady]);

  const logs = active ? state.logs[active.worktree.id] ?? [] : [];
  const frames = state.worktrees.filter((w) => mounted.includes(w.worktree.id));

  // editor pane: draggable height + full-height toggle, persisted
  const centerRef = useRef<HTMLDivElement>(null);
  const [diffH, setDiffH] = useState(() => {
    const n = Number(localStorage.getItem("orch-dh"));
    return Number.isFinite(n) && n >= 120 ? n : 0; // 0 = default 45%
  });
  const [diffFull, setDiffFull] = useState(() => localStorage.getItem("orch-dfull") === "1");
  const toggleFull = () => {
    setDiffFull((f) => {
      localStorage.setItem("orch-dfull", f ? "0" : "1");
      return !f;
    });
  };
  const startDiffDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const handle = e.currentTarget;
    handle.classList.add("active");
    const move = (ev: PointerEvent) => {
      const rect = centerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const h = Math.min(Math.max(rect.bottom - ev.clientY, 120), rect.height - 80);
      setDiffH(h);
      localStorage.setItem("orch-dh", String(Math.round(h)));
    };
    const up = () => {
      document.body.classList.remove("resizing");
      handle.classList.remove("active");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="center" ref={centerRef}>
      <div className="preview-area" style={{ display: state.diff && diffFull ? "none" : undefined }}>
        <div className="frames-wrap">
        {frames.map((w) => (
          <iframe
            key={w.worktree.id}
            ref={(el) => {
              if (el) frameRefs.current.set(w.worktree.id, el);
              else frameRefs.current.delete(w.worktree.id);
            }}
            src={previewUrl(w.worktree.proxyPort)}
            title={w.worktree.title}
            style={{ display: w.worktree.id === state.activeId ? "block" : "none" }}
          />
        ))}
        {!activeReady && (
          <div className="empty">
            {!state.connected
              ? hasToken()
                ? "connecting to daemon…"
                : "no access token for this address —\nrun `orchardist` in your repo, or open the full URL\n(with #token=…) printed in ~/.orchardist/daemon.log"
              : !active
                ? "no worktrees yet — run `orchardist` inside a git repo"
                : logs.length > 0
                  ? logs.slice(-20).join("\n")
                  : "starting dev servers…"}
          </div>
        )}
        </div>
      </div>
      {state.diff && (
        <DiffView
          diff={state.diff}
          state={state}
          dispatch={dispatch}
          sock={sock}
          height={diffFull ? "100%" : diffH > 0 ? diffH : "45%"}
          full={diffFull}
          onToggleFull={toggleFull}
          onDragStart={startDiffDrag}
        />
      )}
      {(() => {
        const activeRepo = active ? state.repos.find((r) => r.id === active.worktree.repoId) : null;
        return activeRepo?.needsSetup ? <ConfigCard key={activeRepo.id} repo={activeRepo} sock={sock} /> : null;
      })()}
      {state.showQuickOpen && active && (
        <QuickOpen
          paths={state.files[active.worktree.id] ?? []}
          commands={buildCommands(state, dispatch, sock, active, repo)}
          onPick={(path) => {
            sock?.send({ t: "file-diff", worktreeId: active.worktree.id, path });
            dispatch({ a: "quick-open", v: false });
          }}
          onClose={() => dispatch({ a: "quick-open", v: false })}
        />
      )}
      {state.showSearch && active && (
        <SearchPalette
          worktreeId={active.worktree.id}
          results={state.search?.worktreeId === active.worktree.id ? state.search : null}
          onQuery={(q) => sock?.send({ t: "search", worktreeId: active.worktree.id, query: q })}
          onPick={(hit) => {
            dispatch({ a: "goto-line", v: { worktreeId: active.worktree.id, path: hit.path, line: hit.line } });
            sock?.send({ t: "file-diff", worktreeId: active.worktree.id, path: hit.path });
            if (!state.leftOpen) dispatch({ a: "toggle-left" });
            dispatch({ a: "show-search", v: false });
          }}
          onClose={() => dispatch({ a: "show-search", v: false })}
        />
      )}
      {state.showCommands && (
        <CommandPalette
          commands={buildCommands(state, dispatch, sock, active, repo)}
          onClose={() => dispatch({ a: "show-commands", v: false })}
        />
      )}
      {state.showPrompt && repo && (
        <PromptOverlay
          onSubmit={(text, variants, batch) => {
            if (batch) {
              sock?.send({ t: "batch-worktrees", repoId: repo.id, prompt: text });
            } else if (variants > 1) {
              const group = Math.random().toString(36).slice(2, 10);
              for (let i = 0; i < variants; i++) {
                sock?.send({
                  t: "create-worktree", repoId: repo.id, prompt: text,
                  variant: { group, index: i + 1, of: variants },
                });
              }
            } else {
              sock?.send({ t: "create-worktree", repoId: repo.id, prompt: text });
            }
            dispatch({ a: "show-prompt", v: false });
            // the agent starts talking in the chat panel — make sure it's on screen
            if (!state.rightOpen) dispatch({ a: "toggle-right" });
          }}
          onClose={() => dispatch({ a: "show-prompt", v: false })}
        />
      )}
    </div>
  );
}

function DiffView({ diff, state, dispatch, sock, height, full, onToggleFull, onDragStart }: {
  diff: NonNullable<State["diff"]>; state: State; dispatch: Dispatch; sock: Sock;
  height: number | string; full: boolean; onToggleFull: () => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const wt = state.worktrees.find((w) => w.worktree.id === diff.worktreeId);
  const absPath = wt ? `${wt.worktree.path}/${diff.path}` : diff.path;
  // warm the line-offset/ranges cache so line-hover highlights align
  useEffect(() => {
    if (!state.changedRanges[`${diff.worktreeId}:${diff.path}`]) {
      sock?.send({ t: "changed-ranges", worktreeId: diff.worktreeId, path: diff.path });
    }
  }, [diff.worktreeId, diff.path]);
  const lineOff = state.changedRanges[`${diff.worktreeId}:${diff.path}`]?.offset ?? 0;
  return (
    <div className="diff-pane" style={{ height }}>
      {!full && <div className="row-resize" onPointerDown={onDragStart} />}
      <div className="file-head" style={{ padding: "6px 16px", display: "flex", gap: 12 }}>
        <span style={{ flex: 1, font: "12px var(--font-mono)", color: "var(--fg-muted)" }}>{diff.path}</span>
        <button
          className="deep-link"
          onClick={onToggleFull}
          data-tip={full ? "Split view — show the preview above" : "Full height — hide the preview"}
        >
          {full ? "◫ split" : "⬒ full"}
        </button>
        <OpenInMenu
          absPath={absPath}
          onReveal={() => sock?.send({ t: "reveal", worktreeId: diff.worktreeId, path: diff.path })}
        />
        <button onClick={() => dispatch({ a: "close-diff" })} {...tip("Close", "esc")}>✕</button>
      </div>
      <Suspense fallback={<div className="empty">loading diff…</div>}>
        <MonacoDiff
          before={diff.before}
          after={diff.after}
          path={diff.path}
          line={diff.line}
          onSave={(content) =>
            sock?.send({ t: "write-file", worktreeId: diff.worktreeId, path: diff.path, content })
          }
          onLineHover={(line) => {
            if (line == null) previewBus.post(diff.worktreeId, { type: "highlight-clear" });
            else
              previewBus.post(diff.worktreeId, {
                type: "highlight-file",
                path: diff.path,
                ranges: [[line + lineOff, line + lineOff]],
              });
          }}
        />
      </Suspense>
    </div>
  );
}

const EDITORS: Array<{ label: string; scheme: string }> = [
  { label: "Zed", scheme: "zed" },
  { label: "VS Code", scheme: "vscode" },
  { label: "Cursor", scheme: "cursor" },
];

function OpenInMenu({ absPath, onReveal }: { absPath: string; onReveal?: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <span style={{ position: "relative", alignSelf: "center" }}>
      <button
        className="deep-link"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        open in ▾
      </button>
      {open && (
        <div className="ctx-menu" style={{ right: 0, top: "calc(100% + 4px)", left: "auto", position: "absolute" }}>
          {EDITORS.map((ed) => (
            <button
              key={ed.scheme}
              onClick={() => {
                window.location.href = `${ed.scheme}://file${absPath}`;
                setOpen(false);
              }}
            >
              {ed.label}
            </button>
          ))}
          {onReveal && (
            <button
              onClick={() => {
                onReveal();
                setOpen(false);
              }}
            >
              reveal in Finder
            </button>
          )}
        </div>
      )}
    </span>
  );
}

function ConfigCard({ repo, sock }: { repo: State["repos"][number]; sock: Sock }) {
  const [procs, setProcs] = useState<Array<{ name: string; cmd: string }>>(() =>
    Object.entries(repo.config.procs).map(([name, cmd]) => ({ name, cmd })),
  );
  const [setup, setSetup] = useState(() => (repo.config.setup ?? []).join("\n"));
  const [exclusive, setExclusive] = useState(repo.config.exclusive ?? false);

  const start = () => {
    const config = {
      procs: Object.fromEntries(procs.filter((p) => p.name.trim() && p.cmd.trim()).map((p) => [p.name.trim(), p.cmd.trim()])),
      setup: setup.split("\n").map((l) => l.trim()).filter(Boolean),
      ...(exclusive ? { exclusive: true } : {}),
    };
    sock?.send({ t: "confirm-config", repoId: repo.id, config });
  };

  return (
    <div className="prompt-overlay">
      <div className="prompt-box config-card" onClick={(e) => e.stopPropagation()}>
        <div className="title">
          first run for <b>{repo.name}</b> — confirm how it runs. Each command must listen on <code>$PORT</code>.
        </div>
        <div className="cfg-section">processes</div>
        {procs.map((p, i) => (
          <div className="cfg-proc" key={i}>
            <input
              className="cfg-name"
              value={p.name}
              placeholder="name"
              onChange={(e) => setProcs(procs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <input
              className="cfg-cmd"
              value={p.cmd}
              placeholder="bun run dev · uvicorn main:app --reload --port $PORT · ./start.sh"
              onChange={(e) => setProcs(procs.map((x, j) => (j === i ? { ...x, cmd: e.target.value } : x)))}
            />
            <button {...tip("Remove")} onClick={() => setProcs(procs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="new-wt" onClick={() => setProcs([...procs, { name: "", cmd: "" }])}>
          + add process
        </button>
        <div className="cfg-section">setup (run once per new worktree)</div>
        <textarea
          className="cfg-setup"
          value={setup}
          onChange={(e) => setSetup(e.target.value)}
          placeholder={"bun install\ncp ../../.env .env"}
        />
        <label className="cfg-exclusive" data-tip="For apps that can't take $PORT: only the focused worktree's processes run">
          <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} />
          <span>exclusive — commands can't honor $PORT, run only the focused worktree</span>
        </label>
        <div className="cfg-actions">
          <span className="cfg-note">saved to orchardist.json in the repo</span>
          <button
            className="ship-btn"
            disabled={procs.every((p) => !p.name.trim() || !p.cmd.trim())}
            onClick={start}
          >
            start ▸
          </button>
        </div>
      </div>
    </div>
  );
}

/** ⌘P: fuzzy file jump; a leading `>` switches the same box to the command palette (editor convention) */
function QuickOpen({ paths, commands, onPick, onClose }: {
  paths: string[];
  commands: Command[];
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const cmdMode = q.startsWith(">");

  const results = useMemo(() => {
    if (cmdMode) return [];
    if (!q.trim()) return paths.slice(0, 50);
    const needle = q.toLowerCase();
    const scored: Array<{ p: string; score: number }> = [];
    for (const p of paths) {
      const s = fuzzyScore(p.toLowerCase(), needle);
      if (s > 0) scored.push({ p, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50).map((x) => x.p);
  }, [q, paths, cmdMode]);
  const cmdResults = useMemo(() => (cmdMode ? filterCommands(commands, q.slice(1)) : []), [q, commands, cmdMode]);
  const count = cmdMode ? cmdResults.length : results.length;
  const runCmd = (c: Command) => { onClose(); c.run(); };

  useEffect(() => setIdx(0), [q]);

  return (
    <div className="prompt-overlay" onClick={onClose}>
      <div className="prompt-box quick-open" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, count - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") {
              e.preventDefault();
              if (cmdMode) { if (cmdResults[idx]) runCmd(cmdResults[idx]!); }
              else if (results[idx]) onPick(results[idx]!);
            }
          }}
          placeholder="jump to file · type > for commands"
        />
        <div className="qo-list">
          {cmdMode
            ? cmdResults.map((c, i) => <CommandRow key={c.id} c={c} active={i === idx} onRun={() => runCmd(c)} />)
            : results.map((p, i) => (
                <button key={p} className={`qo-item ${i === idx ? "active" : ""}`} onClick={() => onPick(p)}>
                  {p}
                </button>
              ))}
          {count === 0 && <div className="dock-empty">{cmdMode ? "no matching command" : "no matches"}</div>}
        </div>
      </div>
    </div>
  );
}

// subsequence match; bonuses for consecutive hits and path-segment starts
function fuzzyScore(hay: string, needle: string): number {
  let score = 0, hi = 0, streak = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, hi);
    if (found === -1) return 0;
    streak = found === hi ? streak + 1 : 1;
    score += streak + (found === 0 || hay[found - 1] === "/" || hay[found - 1] === "." ? 3 : 0);
    hi = found + 1;
  }
  return score + Math.max(0, 40 - hay.length / 4);
}

function PromptOverlay({ onSubmit, onClose }: {
  onSubmit: (t: string, variants: number, batch: boolean) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [variants, setVariants] = useState(1);
  const [batch, setBatch] = useState(false);
  return (
    <div className="prompt-overlay" onClick={onClose}>
      <div className="prompt-box" onClick={(e) => e.stopPropagation()}>
        <div className="title">
          {batch
            ? "batch — an agent splits this into separate worktrees, one per task"
            : "new worktree — describe the change; an agent starts on it immediately"}
        </div>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && text.trim()) {
              e.preventDefault();
              onSubmit(text.trim(), variants, batch);
            }
          }}
          placeholder={
            batch
              ? "fix the header overflow, add a dark mode toggle, and update the footer copy"
              : "make the header sticky and add a dark mode toggle"
          }
        />
        <div className="variants-row">
          <label data-tip="An agent decomposes the request into independent tasks and starts a worktree for each">
            <input type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} />
            <span>batch</span>
          </label>
          {!batch && (
            <span className="variants-right">
              <span data-tip="Run the same prompt in N parallel worktrees — keep the best">variants</span>
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  className={`variant-chip ${variants === n ? "on" : ""}`}
                  onClick={() => setVariants(n)}
                >
                  {n}
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function RightDock({ state, active, sock, dispatch, width }: { state: State; active: WorktreeStatus | null; sock: Sock; dispatch: Dispatch; width: number }) {
  const items = active ? state.chats[active.worktree.id] ?? [] : [];
  const logRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");

  // spawn-a-worktree default: on for main (protect the working copy),
  // off on worktrees (continue that conversation); user can override per tab
  const isMain = active?.worktree.kind === "main";
  const [spawnNew, setSpawnNew] = useState(isMain);
  useEffect(() => setSpawnNew(active?.worktree.kind === "main"), [active?.worktree.id]);

  // conflict resolutions etc. arrive as chat prefills
  useEffect(() => {
    if (state.prefill && active && state.prefill.worktreeId === active.worktree.id) {
      setText(state.prefill.text);
      setSpawnNew(false);
      dispatch({ a: "clear-prefill" });
    }
  }, [state.prefill, active?.worktree.id]);

  // pin to bottom while streaming; offer a jump-down pill when scrolled up
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else if (items.length > 0) {
      setShowJump(true);
    }
  }, [items]);
  useEffect(() => {
    atBottomRef.current = true;
    setShowJump(false);
  }, [active?.worktree.id]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = atBottom;
    if (atBottom) setShowJump(false);
  };

  const jumpDown = () => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setShowJump(false);
  };

  // ambient context: what the user is looking at, attached invisibly to every send
  const pick = state.pick && active && state.pick.worktreeId === active.worktree.id ? state.pick : null;
  const buildContext = (): string | undefined => {
    if (!active) return undefined;
    const parts: string[] = [];
    const pc = state.pageCtx[active.worktree.id];
    if (pc?.url) {
      try {
        const u = new URL(pc.url);
        parts.push(`current route: ${u.pathname}${u.search}`);
      } catch {}
    }
    if (pc?.title) parts.push(`page title: ${pc.title}`);
    if (pc?.errors.length) parts.push(`recent console errors:\n${pc.errors.map((e) => `- ${e}`).join("\n")}`);
    if (pick) {
      const where = pick.file ? ` defined at ${relFile(pick.file, active.worktree.path)}${pick.line ? `:${pick.line}` : ""}` : "";
      parts.push(
        `user-selected element (via the element picker): ${pick.component ? `<${pick.component}> component` : `<${pick.tag}>`}${where}${pick.text ? `, text "${pick.text}"` : ""}\nits HTML: ${pick.html}`,
      );
    }
    if (parts.length === 0) return undefined;
    return `[Live preview context, attached automatically — this is what the user is looking at right now:\n${parts.join("\n")}]`;
  };

  const send = () => {
    if (!active || !text.trim()) return;
    const context = buildContext();
    const pickMeta = pick
      ? { component: pick.component, file: pick.file, line: pick.line, tag: pick.tag, selector: pick.selector }
      : undefined;
    if (spawnNew) {
      sock?.send({
        t: "create-worktree",
        repoId: active.worktree.repoId,
        prompt: text.trim(),
        baseWorktreeId: active.worktree.id,
        context,
        pick: pickMeta,
      });
    } else {
      sock?.send({ t: "chat", worktreeId: active.worktree.id, text: text.trim(), context, pick: pickMeta });
    }
    if (pick) dispatch({ a: "clear-pick" });
    setText("");
  };

  return (
    <div className={`right-dock ${state.rightOpen ? "" : "collapsed"}`} style={{ width }}>
      <div className="chat-wrap">
        <div className="chat-log" ref={logRef} onScroll={onScroll}>
          {items.map((item, i) => (
            <ChatItemView
              key={i}
              item={item}
              onPickHover={(p, entering) => {
                if (!active) return;
                if (entering) {
                  previewBus.post(active.worktree.id, {
                    type: "highlight-selector",
                    selector: p.selector,
                    label: p.component ? `<${p.component}>` : p.tag,
                  });
                } else {
                  previewBus.post(active.worktree.id, { type: "highlight-clear" });
                }
              }}
            />
          ))}
          {active?.agent === "working" && (
          <div className="msg-thinking working-row">
            working…
            <button
              className="stop-btn"
              data-tip="Stop the agent (context up to here is kept; queued messages dropped)"
              onClick={() => sock?.send({ t: "stop-agent", worktreeId: active.worktree.id })}
            >
              ■ stop
            </button>
          </div>
        )}
        {active &&
          (state.queues[active.worktree.id] ?? []).map((text, i) => (
            <div key={`q-${i}`} className="msg-user queued-msg">
              <span className="queued-tag">queued</span>
              <span className="queued-text">{text}</span>
              <span className="queued-actions">
                <button
                  {...tip("Edit — removes from queue, puts it back in the input")}
                  onClick={() => {
                    sock?.send({ t: "unqueue", worktreeId: active.worktree.id, index: i });
                    setText(text);
                  }}
                >
                  ✎
                </button>
                <button
                  {...tip("Remove from queue")}
                  onClick={() => sock?.send({ t: "unqueue", worktreeId: active.worktree.id, index: i })}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
        </div>
        {showJump && (
          <button className="jump-down" onClick={jumpDown} data-tip="Jump to latest">
            ↓ new messages
          </button>
        )}
      </div>
      <div className="chat-input">
        {pick && (
          <div
            className="pick-chip"
            data-tip={pick.html}
            onMouseEnter={() =>
              previewBus.post(active!.worktree.id, {
                type: "highlight-selector",
                selector: pick.selector,
                label: pick.component ? `<${pick.component}>` : pick.tag,
              })
            }
            onMouseLeave={() => previewBus.post(active!.worktree.id, { type: "highlight-clear" })}
          >
            <span className="pick-target">
              ⌖ {pick.component ? `<${pick.component}>` : `<${pick.tag}>`}
              {pick.file && (
                <span className="pick-file">
                  {" "}· {relFile(pick.file, active!.worktree.path)}{pick.line ? `:${pick.line}` : ""}
                </span>
              )}
            </span>
            <button {...tip("Remove attachment")} onClick={() => dispatch({ a: "clear-pick" })}>✕</button>
          </div>
        )}
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
          <label data-tip={isMain ? "Unchecked: the agent edits your main working copy directly" : "Checked: fork a new worktree from this one instead of continuing here"}>
            <input type="checkbox" checked={spawnNew} onChange={(e) => setSpawnNew(e.target.checked)} />
            <span>
              new worktree from <b>{active?.worktree.title ?? "—"}</b>
            </span>
          </label>
          <button
            className={`composer-pick ${state.picking ? "rb-on" : ""}`}
            disabled={!active}
            {...tip("Pick an element on the page to attach", "⌘E")}
            onClick={() => {
              if (!active) return;
              if (state.picking) {
                previewBus.post(active.worktree.id, { type: "pick-cancel" });
                dispatch({ a: "set-picking", v: false });
              } else {
                previewBus.post(active.worktree.id, { type: "pick-start" });
                dispatch({ a: "set-picking", v: true });
              }
            }}
          >
            <Icon name="pick" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text],
  );
  return <div className="msg-assistant md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ChatItemView({ item, onPickHover }: {
  item: ChatItem;
  onPickHover?: (p: NonNullable<Extract<ChatItem, { kind: "user" }>["pick"]>, entering: boolean) => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-user">
          {item.text}
          {item.pick && (
            <div
              className="pick-chip in-chat"
              data-tip="Hover to highlight on the page"
              onMouseEnter={() => onPickHover?.(item.pick!, true)}
              onMouseLeave={() => onPickHover?.(item.pick!, false)}
            >
              ⌖ {item.pick.component ? `<${item.pick.component}>` : `<${item.pick.tag}>`}
              {item.pick.file && (
                <span className="pick-file">
                  {" "}· {relFile(item.pick.file)}{item.pick.line ? `:${item.pick.line}` : ""}
                </span>
              )}
            </div>
          )}
        </div>
      );
    case "assistant":
      return <Markdown text={item.text} />;
    case "thinking":
      return <div className="msg-thinking">{item.text}</div>;
    case "error":
      return <div className="msg-assistant" style={{ color: "var(--red)" }}>{item.text}</div>;
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
}

function toolHint(item: Extract<ChatItem, { kind: "tool" }>): string {
  const input = item.input as Record<string, unknown> | null;
  if (!input) return "";
  const v = input["file_path"] ?? input["command"] ?? input["path"] ?? input["pattern"] ?? "";
  return typeof v === "string" ? v : "";
}

/** ⌘⇧F: content search across the active worktree (git grep in the daemon, debounced) */
function SearchPalette({ worktreeId, results, onQuery, onPick, onClose }: {
  worktreeId: string;
  results: { query: string; hits: SearchHit[]; truncated: boolean } | null;
  onQuery: (q: string) => void;
  onPick: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // focus on open — the chord may arrive while the preview iframe or Monaco holds focus,
  // and autoFocus alone loses that race, so take it explicitly on the next frame too
  useEffect(() => {
    inputRef.current?.focus();
    const f = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(f);
  }, []);

  // debounce the round trip; short queries would match everything
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) return;
    const h = setTimeout(() => onQuery(t), 150);
    return () => clearTimeout(h);
  }, [q, worktreeId]);
  useEffect(() => setIdx(0), [results?.query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".qo-item.active")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const stale = !results || results.query.trim() !== q.trim();
  const hits = results && q.trim().length >= 2 ? results.hits : [];
  return (
    <div className="prompt-overlay" onClick={onClose}>
      <div className="prompt-box quick-open" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, hits.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter" && hits[idx]) { e.preventDefault(); onPick(hits[idx]!); }
          }}
          placeholder="search in files…"
        />
        <div className="qo-list" ref={listRef}>
          {hits.map((h, i) => (
            <button
              key={`${h.path}:${h.line}`}
              className={`qo-item sr-item ${i === idx ? "active" : ""}`}
              onClick={() => onPick(h)}
              title={`${h.path}:${h.line}`}
            >
              <span className="sr-loc">{h.path}<span className="sr-line">:{h.line}</span></span>
              <span className="sr-text">{h.text}</span>
            </button>
          ))}
          {q.trim().length < 2 && <div className="dock-empty">type at least two characters</div>}
          {q.trim().length >= 2 && !stale && hits.length === 0 && <div className="dock-empty">no matches</div>}
          {q.trim().length >= 2 && stale && hits.length === 0 && <div className="dock-empty">searching…</div>}
          {results?.truncated && !stale && <div className="dock-empty">showing the first {hits.length} — narrow the search</div>}
        </div>
      </div>
    </div>
  );
}

/** the ⌘N chord that reaches worktree i, if any: ⌘1–8 by position, ⌘9 always the last one */
function keyHint(i: number, count: number): string | undefined {
  if (i === count - 1) return "⌘9";
  return i < 8 ? `⌘${i + 1}` : undefined;
}

const KEY_SECTIONS: Array<{ title: string; rows: Array<[string, string]> }> = [
  // grid order
  { title: "Find", rows: [["⌘P", "jump to file"], ["⌘⇧F", "search in files"], ["⌘⇧E", "command palette"]] },
  { title: "Panels", rows: [["⌘B", "changes"], ["⌘J", "chat"], ["⌘/", "this list"]] },
  { title: "Preview", rows: [["⌘E", "element picker"], ["⌘.", "full-bleed preview"]] },
  { title: "Worktrees", rows: [["⌘K", "new worktree"], ["⌘1–9", "switch worktree"]] },
];
function KeysHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="keys-overlay" onClick={onClose}>
      <div className="keys-card" onClick={(e) => e.stopPropagation()}>
        {KEY_SECTIONS.map((sec) => (
          <div className="keys-section" key={sec.title}>
            <div className="keys-h">{sec.title}</div>
            {sec.rows.map(([k, d]) => (
              <div className="keys-row" key={k}>
                <span className="keys-k">
                  {/^[⌘⇧⌥⌃]+/.test(k) && <span className="keys-mod">{k.match(/^[⌘⇧⌥⌃]+/)![0]}</span>}
                  {k.replace(/^[⌘⇧⌥⌃]+/, "")}
                </span>
                <span className="keys-d">{d}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* every status-bar glyph comes from here — same 16px box, same 1.3 stroke — so
   the row reads as one family (font glyphs each brought their own weight) */
type IconName = "branch" | "chat" | "help" | "zen" | "back" | "forward" | "reload" | "pick";
const ICON_PATHS: Record<IconName, string> = {
  branch: "M4.5 5.1v5.8 M11.5 6.6c0 2.6-7 1.6-7 4.3 M4.5 1.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M4.5 10.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M11.5 3.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z",
  chat: "M2.5 3.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3.2 2.6V11H4a1.5 1.5 0 0 1-1.5-1.5z",
  help: "M6 6a2.1 2.1 0 1 1 3.9.8c0 1.4-1.9 1.7-1.9 3 M8 12.6h.01",
  zen: "M2.5 6V3.5a1 1 0 0 1 1-1H6 M10 2.5h2.5a1 1 0 0 1 1 1V6 M13.5 10v2.5a1 1 0 0 1-1 1H10 M6 13.5H3.5a1 1 0 0 1-1-1V10",
  back: "M9.5 3.5 5 8l4.5 4.5",
  forward: "M6.5 3.5 11 8l-4.5 4.5",
  reload: "M13.5 2.5v3.5H10 M12.4 9.2a4.8 4.8 0 1 1-1-4.9l2.1 1.7",
  // crosshair: ring with four ticks
  pick: "M8 4.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 1 0 0-7.6z M8 1.5v2.7 M8 11.8v2.7 M1.5 8h2.7 M11.8 8h2.7",
};
function Icon({ name }: { name: IconName }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

function StatusBar({ state, active, dispatch, sock, navCenter }: { state: State; active: WorktreeStatus | null; dispatch: Dispatch; sock: Sock; navCenter: number }) {
  const [installEvt, setInstallEvt] = useState<{ prompt: () => Promise<unknown> } | null>(null);
  useEffect(() => {
    // already running as an app (--app window or installed PWA): don't offer install
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as unknown as { prompt: () => Promise<unknown> });
    };
    const onInstalled = () => setInstallEvt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // route section (merged from the old preview route bar)
  const id = active?.worktree.id ?? null;
  const url = id ? state.pageCtx[id]?.url : undefined;
  const path = useMemo(() => {
    if (!url) return "/";
    try {
      const u = new URL(url);
      // hash included: hash routers (#/about) are common in previews, and the
      // bar should mirror what the page considers its route
      return u.pathname + u.search + u.hash;
    } catch {
      return "/";
    }
  }, [url]);
  const [val, setVal] = useState(path);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setVal(path);
  }, [path, id, editing]);
  const ready = !!active && active.procs.some((p) => p.status === "running" || p.status === "starting");
  const go = (p: string) => {
    if (!id) return;
    const t = p.trim();
    // "/path", "?query" and "#/hash-route" are all valid as typed; anything else is a path
    const clean = /^[/?#]/.test(t) ? t : `/${t}`;
    previewBus.post(id, { type: "navigate", path: clean });
    setEditing(false);
  };
  return (
    <div className="status-bar top-bar">
      <button
        className={`toggle icon ${state.leftOpen ? "on" : ""}`}
        onClick={() => dispatch({ a: "toggle-left" })}
        {...tip("Changes panel", "⌘B")}
      >
        <Icon name="branch" />
      </button>
      <div className="rb-center" style={{ left: navCenter }}>
      <button className="rb-btn rb-nav" disabled={!ready} {...tip("Back")} onClick={() => id && previewBus.post(id, { type: "back" })}><Icon name="back" /></button>
      <button className="rb-btn rb-nav" disabled={!ready} {...tip("Forward")} onClick={() => id && previewBus.post(id, { type: "forward" })}><Icon name="forward" /></button>
      <button className="rb-btn rb-nav rb-reload" disabled={!ready} {...tip("Reload preview")} onClick={() => id && previewBus.post(id, { type: "reload" })}><Icon name="reload" /></button>
      <input
        className="rb-path"
        value={ready ? val : ""}
        disabled={!ready}
        placeholder={ready ? "/" : "—"}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(val);
          if (e.key === "Escape") {
            setVal(path);
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
        spellCheck={false}
      />
      </div>
      {installEvt && (
        <button
          className="toggle"
          data-tip="Install Orchardist as an app (own window, dock icon)"
          onClick={() => void installEvt.prompt()}
        >
          ⇣ install app
        </button>
      )}
      <span className="grow" />
      {/* procs surface only when something needs attention — healthy is silence */}
      {active?.procs
        .filter((p) => p.status !== "running")
        .map((p) => (
          <button
            key={p.name}
            className="proc"
            data-tip={`${p.command} — ${p.status} on :${p.port} · click to restart`}
            onClick={() => sock?.send({ t: "restart-proc", worktreeId: active.worktree.id, proc: p.name })}
          >
            <span className={`dot ${p.status === "crashed" ? "crashed" : "starting"}`} />
            {p.name} {p.status}
          </button>
        ))}
      {/* right cluster: help · chat toggle · zen (zen last — it hides everything, so it sits at the edge) */}
      <span className="bar-tools">
        <button className="toggle icon keys-btn" {...tip("Keyboard shortcuts", "⌘/")} onClick={() => dispatch({ a: "show-keys", v: true })}>
          <Icon name="help" />
        </button>
        <button
          className={`toggle icon ${state.rightOpen ? "on" : ""}`}
          onClick={() => dispatch({ a: "toggle-right" })}
          {...tip("Chat panel", "⌘J")}
        >
          <Icon name="chat" />
        </button>
        <button
          className="toggle icon keys-btn"
          {...tip("Full-bleed preview", "⌘.")}
          onClick={() => dispatch({ a: "toggle-zen" })}
        >
          <Icon name="zen" />
        </button>
      </span>
      {state.showKeys && <KeysHelp onClose={() => dispatch({ a: "show-keys", v: false })} />}
    </div>
  );
}
