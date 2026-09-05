import { Suspense, lazy, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { WorktreeStatus } from "@orchardist/shared";
import { BRIDGE_VERSION } from "@orchardist/shared";
import { DaemonSocket, hasToken } from "./ws.ts";
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

  // window/app title follows the active worktree
  useEffect(() => {
    document.title = active ? `${active.worktree.title} — orchardist` : "orchardist";
  }, [active?.worktree.title]);

  // keyboard: cmd+1..9 switch tabs, cmd+k new worktree, cmd+b/j toggle docks, esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key >= "1" && e.key <= "9") {
        const wt = state.worktrees[Number(e.key) - 1];
        if (wt) { e.preventDefault(); dispatch({ a: "activate", id: wt.worktree.id }); }
      } else if (e.metaKey && e.key === "k") {
        e.preventDefault();
        dispatch({ a: "show-prompt", v: true });
      } else if (e.metaKey && e.key === "p") {
        e.preventDefault();
        if (state.activeId) {
          sockRef.current?.send({ t: "list-files", worktreeId: state.activeId });
          dispatch({ a: "quick-open", v: true });
        }
      } else if (e.metaKey && e.key === "e") {
        e.preventDefault();
        if (state.picking) {
          if (state.activeId) previewBus.post(state.activeId, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        } else if (state.activeId) {
          previewBus.post(state.activeId, { type: "pick-start" });
          dispatch({ a: "set-picking", v: true });
        }
      } else if (e.metaKey && e.key === "b") {
        e.preventDefault();
        dispatch({ a: "toggle-left" });
      } else if (e.metaKey && e.key === "j") {
        e.preventDefault();
        dispatch({ a: "toggle-right" });
      } else if (e.key === "Escape") {
        if (state.showQuickOpen) dispatch({ a: "quick-open", v: false });
        else if (state.showPrompt) dispatch({ a: "show-prompt", v: false });
        else if (state.diff) dispatch({ a: "close-diff" });
      }
    };
    window.addEventListener("keydown", onKey);
    // (⌘E arrives from the iframe too, via the bridge chord forwarding)
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (d && d.__orchardist && d.type === "key" && d.meta) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: d.key, metaKey: true }));
      }
    };
    window.addEventListener("message", onMsg);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMsg);
    };
  }, [state.worktrees, state.diff, state.showPrompt, state.showQuickOpen, state.activeId, state.picking]);

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

  // resizable docks, widths persisted per browser
  const [leftW, setLeftW] = useState(() => clampW(Number(localStorage.getItem("orch-lw")), 220));
  const [rightW, setRightW] = useState(() => clampW(Number(localStorage.getItem("orch-rw")), 380));
  const startDrag = (side: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      if (side === "left") {
        const w = clampW(ev.clientX, 220);
        setLeftW(w);
        localStorage.setItem("orch-lw", String(w));
      } else {
        const w = clampW(window.innerWidth - ev.clientX, 380);
        setRightW(w);
        localStorage.setItem("orch-rw", String(w));
      }
    };
    const up = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="app">
      <div className="docks">
        <LeftDock state={state} dispatch={dispatch} sock={sock} width={leftW} />
        {state.leftOpen && <div className="dock-resize" onPointerDown={startDrag("left")} />}
        <Center state={state} active={active} dispatch={dispatch} sock={sock} repo={repo} />
        {state.rightOpen && <div className="dock-resize" onPointerDown={startDrag("right")} />}
        <RightDock state={state} active={active} sock={sock} dispatch={dispatch} width={rightW} />
      </div>
      <StatusBar state={state} active={active} dispatch={dispatch} sock={sock} />
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
      previewBus.post(state.activeId, { type: "highlight-file", path, ranges: cached });
    } else {
      sock?.send({ t: "changed-ranges", worktreeId: state.activeId, path });
    }
  };
  useEffect(() => {
    const path = hoverPathRef.current;
    if (!path || !state.activeId) return;
    const ranges = state.changedRanges[`${state.activeId}:${path}`];
    if (ranges) previewBus.post(state.activeId, { type: "highlight-file", path, ranges });
  }, [state.changedRanges]);

  return (
    <div className={`left-dock ${state.leftOpen ? "" : "collapsed"}`} style={{ width }}>
      {(behind > 0 || ahead > 0 || active?.worktree.landed) && (
        <div className="dock-section-title changes-head">
          <span>
            {behind > 0 && <span className="behind-badge" title={`${behind} commit(s) behind main`}>↓{behind} </span>}
            {ahead > 0 && <span className="ahead-badge" title={`${ahead} commit(s) ahead of main`}>↑{ahead} </span>}
            {active?.worktree.landed && <span className="landed-badge" title="Merged into main">✓ landed</span>}
          </span>
          {isWt && clean && (behind > 0 || ahead > 0) && (
            <span className="land-btns">
              {behind > 0 && (
                <button
                  className="ship-btn"
                  title={`Pull ${behind} commit(s) from main into this worktree`}
                  onClick={() => sock?.send({ t: "sync-main", worktreeId: active.worktree.id })}
                >
                  sync ↓
                </button>
              )}
              {ahead > 0 && (
                <>
                  <button
                    className="ship-btn"
                    title={
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
                      title={`PR open — click to view · ${active.worktree.prUrl}`}
                      onClick={() => window.open(active.worktree.prUrl, "_blank")}
                    >
                      pr open ↗
                    </button>
                  ) : (
                    <button
                      className="ship-btn"
                      title="Push and open a PR"
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
              <span className={`xy ${xyClass(f.xy)}`}>{f.xy.trim() || "·"}</span>
              <span className="path">{f.path}</span>
            </button>
          ))}
          <div className="commit-box">
            <input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              placeholder="commit message…"
            />
            <button className="ship-btn" disabled={!commitMsg.trim()} onClick={commit} title="git add -A && git commit">
              commit
            </button>
          </div>
        </>
      )}
      {(gitInfo?.committed?.length ?? 0) > 0 && (
        <>
          <div className="dock-section-title" title="Committed on this branch, not yet on main">
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
              <span className={`xy ${xyClass(f.xy)}`}>{f.xy.trim() || "·"}</span>
              <span className="path">{f.path}</span>
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

function WtSwitcher({ state, dispatch, sock }: { state: State; dispatch: Dispatch; sock: Sock }) {
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; land?: boolean } | null>(null);
  const [graftMode, setGraftMode] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const active = state.worktrees.find((w) => w.worktree.id === state.activeId) ?? null;

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

  const rename = (w: WorktreeStatus) => {
    if (w.worktree.kind === "main") return;
    const title = window.prompt("Rename worktree (also renames its branch):", w.worktree.title);
    if (title && title.trim()) {
      sock?.send({ t: "rename-worktree", worktreeId: w.worktree.id, title: title.trim() });
    }
  };

  const pickVariant = (w: WorktreeStatus) => {
    const v = w.worktree.variant;
    if (!v) return;
    const others = v.of - 1;
    if (window.confirm(`Keep "${w.worktree.title}" and remove ${others} sibling variant(s)? Their branches and changes are deleted.`)) {
      sock?.send({ t: "pick-variant", worktreeId: w.worktree.id });
    }
  };

  const remove = (w: WorktreeStatus) => {
    if (w.worktree.kind === "main") return;
    const ok = window.confirm(
      `Remove worktree "${w.worktree.title}"?\n\nThis deletes its directory and branch (${w.worktree.branch}). Unmerged changes are lost.`,
    );
    if (ok) sock?.send({ t: "remove-worktree", worktreeId: w.worktree.id });
  };

  const menuWt = menu ? state.worktrees.find((w) => w.worktree.id === menu.id) ?? null : null;

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
              className={`wt-item ${w.worktree.id === state.activeId ? "active" : ""} ${sel.includes(w.worktree.id) ? "sel" : ""} ${menu?.id === w.worktree.id ? "menu-open" : ""}`}
              onClick={(e) => {
                if (graftMode || e.shiftKey) toggleSel(w);
                else dispatch({ a: "activate", id: w.worktree.id });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: w.worktree.id });
              }}
              title={`⌘${i + 1} · ${w.worktree.branch}${graftMode ? " · click to select" : " · shift-click to graft"}`}
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
                  title={`variant ${w.worktree.variant.index} of ${w.worktree.variant.of} — click to keep this one and remove the others`}
                  onClick={(e) => {
                    e.stopPropagation();
                    pickVariant(w);
                  }}
                >
                  <span className="num">v{w.worktree.variant.index}/{w.worktree.variant.of}</span>
                  <span className="act">pick</span>
                </span>
              )}
              {(w.behind ?? 0) > 0 && (
                <span
                  className="row-badge behind-badge clickable"
                  title={`${w.behind} commit(s) behind main — click to sync`}
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
                  title={`${w.ahead} commit(s) ahead of main — land it`}
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
                title="Actions"
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
                className="new-wt combine-btn"
                disabled={sel.length < 2}
                onClick={() => {
                  sock?.send({ t: "combine", worktreeIds: sel });
                  cancelGraft();
                }}
              >
                ⧉ graft {sel.length >= 2 ? `${sel.length} worktrees` : "— pick 2+"}
              </button>
              <button className="new-wt graft-cancel" onClick={cancelGraft}>
                <span>cancel</span>
                <span className="kbd-hint">esc</span>
              </button>
            </div>
          )}
          {!graftMode && (
            <button className="new-wt" onClick={() => dispatch({ a: "show-prompt", v: true })}>
              <span>+ new worktree</span>
              <span className="kbd-hint">⌘K</span>
            </button>
          )}
        </div>
      )}
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
  const staleReloaded = useRef(new Set<string>());
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || !d.__orchardist) return;
      for (const [id, frame] of frameRefs.current) {
        if (frame.contentWindow === e.source) {
          if (d.type === "hmr") dispatch({ a: "hmr", id });
          else if (d.type === "loaded") {
            // persistent iframes keep old bridges — reload once on version skew
            if (d.v !== BRIDGE_VERSION && !staleReloaded.current.has(id)) {
              staleReloaded.current.add(id);
              frame.src = frame.src;
              return;
            }
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
    const move = (ev: PointerEvent) => {
      const rect = centerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const h = Math.min(Math.max(rect.bottom - ev.clientY, 120), rect.height - 80);
      setDiffH(h);
      localStorage.setItem("orch-dh", String(Math.round(h)));
    };
    const up = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="center" ref={centerRef}>
      <div className="preview-area" style={{ display: state.diff && diffFull ? "none" : undefined }}>
        {frames.map((w) => (
          <iframe
            key={w.worktree.id}
            ref={(el) => {
              if (el) frameRefs.current.set(w.worktree.id, el);
              else frameRefs.current.delete(w.worktree.id);
            }}
            src={`http://127.0.0.1:${w.worktree.proxyPort}/`}
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
      {state.showQuickOpen && active && (
        <QuickOpen
          paths={state.files[active.worktree.id] ?? []}
          onPick={(path) => {
            sock?.send({ t: "file-diff", worktreeId: active.worktree.id, path });
            dispatch({ a: "quick-open", v: false });
          }}
          onClose={() => dispatch({ a: "quick-open", v: false })}
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
  return (
    <div className="diff-pane" style={{ height }}>
      {!full && <div className="row-resize" onPointerDown={onDragStart} />}
      <div className="file-head" style={{ padding: "6px 16px", display: "flex", gap: 12 }}>
        <span style={{ flex: 1, font: "12px var(--font-mono)", color: "var(--fg-muted)" }}>{diff.path}</span>
        <button
          className="deep-link"
          onClick={onToggleFull}
          title={full ? "Split view — show the preview above" : "Full height — hide the preview"}
        >
          {full ? "◫ split" : "⬒ full"}
        </button>
        <OpenInMenu
          absPath={absPath}
          onReveal={() => sock?.send({ t: "reveal", worktreeId: diff.worktreeId, path: diff.path })}
        />
        <button onClick={() => dispatch({ a: "close-diff" })} title="Close (esc)">✕</button>
      </div>
      <Suspense fallback={<div className="empty">loading diff…</div>}>
        <MonacoDiff
          before={diff.before}
          after={diff.after}
          path={diff.path}
          onSave={(content) =>
            sock?.send({ t: "write-file", worktreeId: diff.worktreeId, path: diff.path, content })
          }
          onLineHover={(line) => {
            if (line == null) previewBus.post(diff.worktreeId, { type: "highlight-clear" });
            else previewBus.post(diff.worktreeId, { type: "highlight-file", path: diff.path, ranges: [[line, line]] });
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

function QuickOpen({ paths, onPick, onClose }: {
  paths: string[];
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const results = useMemo(() => {
    if (!q.trim()) return paths.slice(0, 50);
    const needle = q.toLowerCase();
    const scored: Array<{ p: string; score: number }> = [];
    for (const p of paths) {
      const s = fuzzyScore(p.toLowerCase(), needle);
      if (s > 0) scored.push({ p, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50).map((x) => x.p);
  }, [q, paths]);

  useEffect(() => setIdx(0), [q]);

  return (
    <div className="prompt-overlay" onClick={onClose}>
      <div className="prompt-box quick-open" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter" && results[idx]) { e.preventDefault(); onPick(results[idx]!); }
          }}
          placeholder="jump to file…"
        />
        <div className="qo-list">
          {results.map((p, i) => (
            <button key={p} className={`qo-item ${i === idx ? "active" : ""}`} onClick={() => onPick(p)}>
              {p}
            </button>
          ))}
          {results.length === 0 && <div className="dock-empty">no matches</div>}
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
          <label title="An agent decomposes the request into independent tasks and starts a worktree for each">
            <input type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} />
            <span>batch</span>
          </label>
          {!batch && (
            <span className="variants-right">
              <span title="Run the same prompt in N parallel worktrees — keep the best">variants</span>
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
      <WtSwitcher state={state} dispatch={dispatch} sock={sock} />
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
              title="Stop the agent (context up to here is kept; queued messages dropped)"
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
                  title="Edit — removes from queue, puts it back in the input"
                  onClick={() => {
                    sock?.send({ t: "unqueue", worktreeId: active.worktree.id, index: i });
                    setText(text);
                  }}
                >
                  ✎
                </button>
                <button
                  title="Remove from queue"
                  onClick={() => sock?.send({ t: "unqueue", worktreeId: active.worktree.id, index: i })}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
        </div>
        {showJump && (
          <button className="jump-down" onClick={jumpDown} title="Jump to latest">
            ↓ new messages
          </button>
        )}
      </div>
      <div className="chat-input">
        {pick && (
          <div
            className="pick-chip"
            title={pick.html}
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
            <button title="Remove attachment" onClick={() => dispatch({ a: "clear-pick" })}>✕</button>
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
              title="Hover to highlight on the page"
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
        <div className="blocked-row" title={item.reason}>
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

function StatusBar({ state, active, dispatch, sock }: { state: State; active: WorktreeStatus | null; dispatch: Dispatch; sock: Sock }) {
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
        className="toggle icon pick-toggle"
        disabled={!active}
        title="Reload preview"
        onClick={() => {
          if (!active) return;
          previewBus.post(active.worktree.id, { type: "reload" });
        }}
      >
        ⟳
      </button>
      <button
        className={`toggle icon pick-toggle ${state.picking ? "on picking" : ""}`}
        disabled={!active}
        title="Pick an element on the page for the chat (⌘E)"
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
        ⌖
      </button>
      {installEvt && (
        <button
          className="toggle"
          title="Install Orchardist as an app (own window, dock icon)"
          onClick={() => void installEvt.prompt()}
        >
          ⇣ install app
        </button>
      )}
      <span className="grow" />
      {active && (
        <>
          <span className="branch">{active.worktree.branch}</span>
          {active.procs.map((p) => (
            <button
              key={p.name}
              className="proc"
              title={`${p.command} — ${p.status} on :${p.port} · click to restart`}
              onClick={() => sock?.send({ t: "restart-proc", worktreeId: active.worktree.id, proc: p.name })}
            >
              <span className={`dot ${p.status === "running" ? "running" : p.status === "crashed" ? "crashed" : "starting"}`} />
              {p.name}
            </button>
          ))}
        </>
      )}
      <span title={state.connected ? "Connected to daemon" : "Reconnecting to daemon"}>
        {state.connected ? "●" : "○"}
      </span>
      <button
        className={`toggle icon ${state.rightOpen ? "on" : ""}`}
        onClick={() => dispatch({ a: "toggle-right" })}
        title="Toggle chat panel (⌘J)"
      >
        <PanelIcon side="right" filled={state.rightOpen} />
      </button>
    </div>
  );
}
