import type {
  ChordId,
  GitFileStatus,
  RepoInfo,
  SearchHit,
  ShellToBridgeMsg,
  Theme,
  ThemePrefs,
  WorktreeStatus,
} from "@orchardist/shared";
import {
  CHORD_SECTIONS,
  CHORDS,
  chordLabel,
  effectiveKind,
  matchChord,
  PROTOCOL_VERSION,
  parseBridgeMsg,
  pickFamily,
  resolveTheme,
  type ThemeFamily,
  themeFamilies,
  worktreeChord,
  worktreeIndex,
} from "@orchardist/shared";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { previewBus } from "./app/previewBus.ts";
import { matchPositions, rankFiles, splitPath } from "./quickOpen.ts";
import { useDispatch, useSock, useStore } from "./state/context.tsx";
import { STORAGE } from "./state/keys.ts";
import { type Action, type ChatItem, currentTheme, type State } from "./state/store.ts";
import { clampW, dotClass, EDITORS, previewUrl, relFile, shiftRanges, xyClass, xyLetter } from "./surfaces/util.ts";
import { Tooltips, tip } from "./Tooltip.tsx";
import { applyTheme, bridgeThemeMsg, onPrefersDarkChange } from "./theme.ts";
import { type DaemonSocket, hasToken } from "./ws.ts";

const MonacoDiff = lazy(() => import("./MonacoDiff.tsx"));

export function App() {
  const state = useStore((s) => s);
  const dispatch = useDispatch();
  const sock = useSock();
  // the key handler closes over a ref so its effect doesn't re-subscribe when the socket changes
  const sockRef = useRef(sock);
  sockRef.current = sock;
  const active = state.worktrees.find((w) => w.worktree.id === state.activeId) ?? null;

  // subscribe when the active worktree changes
  useEffect(() => {
    if (state.activeId && sock) sock.send({ t: "subscribe", worktreeId: state.activeId });
  }, [state.activeId, state.connected]);

  // window/app title follows the active worktree
  useEffect(() => {
    document.title = active ? `${active.worktree.title} — orchardist` : "orchardist";
  }, [active?.worktree.title]);

  // paint the selected theme (or the picker's live preview); previews get the accent for their overlays
  const theme = currentTheme(state);
  useEffect(() => {
    applyTheme(theme);
    previewBus.broadcast(bridgeThemeMsg(theme));
  }, [theme]);
  useEffect(() => onPrefersDarkChange((v) => dispatch({ a: "system-dark", v })), []);

  // remember the selection across reloads
  useEffect(() => {
    if (state.activeId) {
      try {
        localStorage.setItem(STORAGE.active, state.activeId);
      } catch {}
    }
  }, [state.activeId]);

  // keyboard: cmd+1..9 switch tabs; every other chord toggles its panel (cmd+k prompt, cmd+p jump, cmd+b/j docks…); esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chord = matchChord(e);
      if (chord) {
        e.preventDefault();
        switch (chord.id) {
          case "worktree": {
            const i = worktreeIndex(chord.digit, state.worktrees.length);
            const wt = i === null ? undefined : state.worktrees[i];
            if (wt) dispatch({ a: "activate", id: wt.worktree.id });
            break;
          }
          case "new":
            dispatch({ a: "toggle", overlay: { kind: "prompt" } });
            break;
          case "quick-open":
            if (state.overlay?.kind === "quick-open") {
              dispatch({ a: "close" });
            } else if (state.activeId) {
              sockRef.current?.send({ t: "list-files", worktreeId: state.activeId });
              dispatch({ a: "open", overlay: { kind: "quick-open" } });
            }
            break;
          case "pick":
            if (state.picking) {
              if (state.activeId) previewBus.post(state.activeId, { type: "pick-cancel" });
              dispatch({ a: "set-picking", v: false });
            } else if (state.activeId) {
              previewBus.post(state.activeId, { type: "pick-start" });
              dispatch({ a: "set-picking", v: true });
            }
            break;
          case "search":
            if (state.activeId) dispatch({ a: "toggle", overlay: { kind: "search" } });
            break;
          case "commands":
            dispatch({ a: "toggle", overlay: { kind: "commands" } });
            break;
          case "zen":
            dispatch({ a: "toggle-zen" });
            break;
          case "left":
            dispatch({ a: "toggle-left" });
            break;
          case "right":
            dispatch({ a: "toggle-right" });
            break;
          case "keys":
            dispatch({ a: "toggle", overlay: { kind: "keys" } });
            break;
        }
      } else if (e.key === "Escape") {
        if (state.overlay) {
          // sub-pickers go back to the palette they came from; everything else just closes
          dispatch({ a: "close", back: state.overlay.kind === "theme" || state.overlay.kind === "appearance" });
        } else if (state.picking) {
          // (the bridge handles esc itself when the preview has focus; this covers focus in the shell)
          if (state.activeId) previewBus.post(state.activeId, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        } else if (state.zen) dispatch({ a: "toggle-zen" });
        else if (state.diff) dispatch({ a: "close-diff" });
      }
    };
    window.addEventListener("keydown", onKey);
    // (⌘E arrives from the iframe too: Center re-dispatches bridge "key" messages as keydown)
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [state.worktrees, state.diff, state.activeId, state.picking, state.zen, state.overlay]);

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
        const u = state.local[id]?.page.url;
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
  const [leftW, setLeftW] = useState(() => clampW(Number(localStorage.getItem(STORAGE.leftWidth)), 220));
  const [rightW, setRightW] = useState(() => clampW(Number(localStorage.getItem(STORAGE.rightWidth)), 380));
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
        localStorage.setItem(STORAGE.leftWidth, String(w));
      } else {
        // the worktree rail sits between the chat dock and the window edge
        const w = clampW(window.innerWidth - railPx - ev.clientX, 380);
        setRightW(w);
        localStorage.setItem(STORAGE.rightWidth, String(w));
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
        <LeftDock state={state} sock={sock} width={leftW} />
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
type Dispatch = (a: Action) => void;

function LeftDock({ state, sock, width }: { state: State; sock: Sock; width: number }) {
  const gitInfo = state.activeId ? state.local[state.activeId]?.git : undefined;
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
    const cached = state.local[state.activeId]?.changedRanges[path];
    if (cached) {
      previewBus.post(state.activeId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
    } else {
      sock?.send({ t: "changed-ranges", worktreeId: state.activeId, path });
    }
  };
  useEffect(() => {
    const path = hoverPathRef.current;
    if (!path || !state.activeId) return;
    const cached = state.local[state.activeId]?.changedRanges[path];
    if (cached) previewBus.post(state.activeId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
  }, [state.local]);

  return (
    <div className={`left-dock ${state.leftOpen ? "" : "collapsed"}`} style={{ width }}>
      {(behind > 0 || ahead > 0 || active?.worktree.landed) && (
        <div className="dock-section-title changes-head">
          <span>
            {behind > 0 && (
              <span className="behind-badge" data-tip={`${behind} commit(s) behind main`}>
                ↓{behind}{" "}
              </span>
            )}
            {ahead > 0 && (
              <span className="ahead-badge" data-tip={`${ahead} commit(s) ahead of main`}>
                ↑{ahead}{" "}
              </span>
            )}
            {active?.worktree.landed && (
              <span className="landed-badge" data-tip="Merged into main">
                ✓ landed
              </span>
            )}
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
              onClick={() => state.activeId && sock?.send({ t: "file-diff", worktreeId: state.activeId, path: f.path })}
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
            <button
              className="ship-btn"
              disabled={!commitMsg.trim()}
              onClick={commit}
              data-tip="git add -A && git commit"
            >
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
              onClick={() => state.activeId && sock?.send({ t: "file-diff", worktreeId: state.activeId, path: f.path })}
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
          <button onClick={() => sock?.send({ t: "reveal", worktreeId: active.worktree.id, path: fileMenu.path })}>
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

function WtRail({ state, dispatch, sock }: { state: State; dispatch: Dispatch; sock: Sock }) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; land?: boolean } | null>(null);
  const [graftMode, setGraftMode] = useState(false);
  const [sel, setSel] = useState<string[]>([]);

  const toggleSel = (w: WorktreeStatus) => {
    if (w.worktree.kind === "main") return;
    setGraftMode(true);
    setSel((s) => (s.includes(w.worktree.id) ? s.filter((x) => x !== w.worktree.id) : [...s, w.worktree.id]));
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

  const menuWt = menu ? (state.worktrees.find((w) => w.worktree.id === menu.id) ?? null) : null;

  return (
    <div className={`wt-rail ${graftMode || menu ? "hold" : ""} ${state.connected ? "" : "offline"}`}>
      <div className="rail-panel">
        {
          <div className="rail-list">
            {state.worktrees.map((w) => (
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
                    <span className="num">
                      v{w.worktree.variant.index}/{w.worktree.variant.of}
                    </span>
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
              <button
                className="new-wt"
                data-tip="New worktree"
                data-tip-key={chord("new")}
                onClick={() => dispatch({ a: "open", overlay: { kind: "prompt" } })}
              >
                <span className="nw-full">+ new worktree</span>
                <span className="nw-mini">+</span>
                <span className="kbd-hint nw-full">⌘K</span>
              </button>
            )}
          </div>
        }
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
            <button onClick={() => sock?.send({ t: "ship", worktreeId: menuWt.worktree.id })}>push + PR</button>
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
                {menuWt.worktree.variant && <button onClick={() => pickVariant(menuWt)}>keep this variant…</button>}
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
                <button onClick={() => sock?.send({ t: "ship", worktreeId: menuWt.worktree.id })}>push + PR</button>
                <button className="danger" onClick={() => remove(menuWt)}>
                  remove…
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** confirm-then-send worktree actions, shared by the rail's context menu and the ⌘⇧P palette */
function wtActions(sock: Sock) {
  return {
    rename(w: WorktreeStatus) {
      if (w.worktree.kind === "main") return;
      const title = window.prompt("Rename worktree (also renames its branch):", w.worktree.title);
      if (title?.trim()) {
        sock?.send({ t: "rename-worktree", worktreeId: w.worktree.id, title: title.trim() });
      }
    },
    pickVariant(w: WorktreeStatus) {
      const v = w.worktree.variant;
      if (!v) return;
      const others = v.of - 1;
      if (
        window.confirm(
          `Keep "${w.worktree.title}" and remove ${others} sibling variant(s)? Their branches and changes are deleted.`,
        )
      ) {
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

type Command = {
  id: string;
  label: string;
  hint?: string;
  run: () => void /** opens a sub-picker: esc there returns to the palette */;
  sub?: boolean;
};

/** everything the UI can do, as typeable commands — chords first, then the context-menu long tail */
function buildCommands(
  state: State,
  dispatch: Dispatch,
  sock: Sock,
  active: WorktreeStatus | null,
  repo: RepoInfo | null,
): Command[] {
  const cmds: Command[] = [];
  const add = (id: string, label: string, run: () => void, hint?: string, sub?: boolean) =>
    cmds.push({ id, label, hint, run, sub });
  const wt = active;
  const id = wt?.worktree.id;

  if (repo) add("new", "new worktree…", () => dispatch({ a: "open", overlay: { kind: "prompt" } }), chord("new"));
  if (id) {
    add(
      "jump",
      "jump to file…",
      () => {
        sock?.send({ t: "list-files", worktreeId: id });
        dispatch({ a: "open", overlay: { kind: "quick-open" } });
      },
      chord("quick-open"),
    );
    add("search", "search in files…", () => dispatch({ a: "open", overlay: { kind: "search" } }), chord("search"));
    add(
      "pick",
      state.picking ? "cancel element picker" : "pick an element on the page",
      () => {
        if (state.picking) {
          previewBus.post(id, { type: "pick-cancel" });
          dispatch({ a: "set-picking", v: false });
        } else {
          previewBus.post(id, { type: "pick-start" });
          dispatch({ a: "set-picking", v: true });
        }
      },
      chord("pick"),
    );
    add("reload", "reload preview", () => previewBus.post(id, { type: "reload" }));
  }
  add("left", `${state.leftOpen ? "hide" : "show"} changes panel`, () => dispatch({ a: "toggle-left" }), chord("left"));
  add(
    "right",
    `${state.rightOpen ? "hide" : "show"} chat panel`,
    () => dispatch({ a: "toggle-right" }),
    chord("right"),
  );
  add("zen", "full-bleed preview", () => dispatch({ a: "toggle-zen" }), chord("zen"));
  add("keys", "shortcuts & settings", () => dispatch({ a: "open", overlay: { kind: "keys" } }), chord("keys"));

  const prefs = state.themePrefs;
  const themeName = (tid: string) => state.themes.find((t) => t.id === tid)?.name ?? tid;
  add(
    "theme",
    "theme…",
    () => dispatch({ a: "open", overlay: { kind: "theme", slot: "theme" } }),
    resolveTheme(prefs, state.themes, state.systemDark).name,
    true,
  );
  add(
    "appearance",
    "theme: light/dark mode…",
    () => dispatch({ a: "open", overlay: { kind: "appearance" } }),
    appearanceLabel[prefs.mode],
    true,
  );
  add("theme-import", "theme: import VS Code theme file…", () =>
    pickThemeFile((name, source) => sock?.send({ t: "import-theme", name, source })),
  );
  add("theme-rescan", "theme: rescan installed editor themes", () => sock?.send({ t: "rescan-themes" }));
  // per-slot overrides for mismatched pairs; the picker fills both slots by family so these sit last
  add(
    "theme-dark",
    "theme: dark slot override…",
    () => dispatch({ a: "open", overlay: { kind: "theme", slot: "dark" } }),
    themeName(prefs.dark),
    true,
  );
  add(
    "theme-light",
    "theme: light slot override…",
    () => dispatch({ a: "open", overlay: { kind: "theme", slot: "light" } }),
    themeName(prefs.light),
    true,
  );

  if (wt && id) {
    const acts = wtActions(sock);
    const t = wt.worktree.title;
    if (wt.agent === "working") add("stop", `stop agent — ${t}`, () => sock?.send({ t: "stop-agent", worktreeId: id }));
    for (const p of wt.procs)
      add(`restart:${p.name}`, `restart ${p.name} (${p.status})`, () =>
        sock?.send({ t: "restart-proc", worktreeId: id, proc: p.name }),
      );
    add("reveal", `reveal in Finder — ${t}`, () => sock?.send({ t: "reveal", worktreeId: id }));
    if ((wt.behind ?? 0) > 0)
      add("sync", `sync main into ${t} (${wt.behind} behind)`, () => sock?.send({ t: "sync-main", worktreeId: id }));
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
    const v = w.worktree.variant;
    add(
      `go:${w.worktree.id}`,
      `switch to ${w.worktree.title}${v ? ` (v${v.index}/${v.of})` : ""}`,
      () => dispatch({ a: "activate", id: w.worktree.id }),
      worktreeChord(i, state.worktrees.length),
    );
  });
  return cmds;
}

function filterCommands(commands: Command[], q: string): Command[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return commands;
  const scored: Array<{ c: Command; score: number }> = [];
  for (const c of commands) {
    const s = commandScore(c.label.toLowerCase(), needle);
    if (s > 0) scored.push({ c, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.c);
}

/** browser file dialog → raw theme text (the daemon parses JSONC and converts) */
function pickThemeFile(onText: (name: string, source: string) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,.jsonc,application/json";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) f.text().then((source) => onText(f.name, source));
  };
  input.click();
}

/** the overlays only scrim the preview column, so a click on a dock or the rail wouldn't reach the
 * backdrop — dismiss on any mousedown outside the box instead (the ? button is exempt: it toggles) */
function useDismissOutside(box: React.RefObject<HTMLElement | null>, onOutside: () => void) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(".keys-btn")) return;
      if (box.current && !box.current.contains(t as Node)) cb.current();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
}

/** ↑↓ with wrap-around */
function step(i: number, delta: number, n: number): number {
  return n === 0 ? 0 : (i + delta + n) % n;
}

const appearanceLabel: Record<ThemePrefs["mode"], string> = { dark: "dark", light: "light", system: "follow system" };

/** the one list-picker: overlay + filter input + rows, ↑↓ wrap, enter picks, ←→ optional,
 * hover highlights, active row reported so a parent can live-preview. Every palette-shaped
 * overlay builds on this rather than carrying its own copy of the keyboard machinery. */
function ListPicker<T>({
  items,
  filter,
  keyOf,
  row,
  onPick,
  onBack,
  onActive,
  onSide,
  placeholder,
  initialQuery = "",
  initialIndex,
  empty = "no matches",
}: {
  items: T[];
  /** narrow the list for a query (empty query → everything) */
  filter: (items: T[], q: string) => T[];
  keyOf: (t: T) => string;
  row: (t: T, active: boolean, q: string) => React.ReactNode;
  onPick: (t: T, q: string) => void;
  /** esc / backdrop */
  onBack: () => void;
  onActive?: (t: T | null) => void;
  /** ←→ on the highlighted row */
  onSide?: (t: T, dir: -1 | 1) => void;
  placeholder: string;
  initialQuery?: string;
  /** where the highlight starts (mount only); default 0 */
  initialIndex?: (results: T[]) => number;
  empty?: string;
}) {
  const [q, setQ] = useState(initialQuery);
  const results = useMemo(() => filter(items, q), [items, q, filter]);
  const [idx, setIdx] = useState(() => Math.max(0, initialIndex?.(results) ?? 0));
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useDismissOutside(boxRef, onBack);
  useEffect(() => {
    inputRef.current?.focus();
    const f = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(f);
  }, []);
  // typing resets the highlight; the mount keeps initialIndex
  const prevQ = useRef(q);
  useEffect(() => {
    if (prevQ.current !== q) {
      prevQ.current = q;
      setIdx(0);
    }
  }, [q]);
  // keyed on the row's key, not the results array: parents rebuild items every render, and a
  // re-report on identity change would reset any state they keep for the active row (←→ peek)
  const activeKey = results[idx] ? keyOf(results[idx]!) : null;
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".qo-item.active")?.scrollIntoView({ block: "nearest" });
    onActive?.(results[idx] ?? null);
  }, [activeKey]);
  return (
    <div className="prompt-overlay">
      <div className="prompt-box quick-open" ref={boxRef}>
        <input
          ref={inputRef}
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => step(i, 1, results.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => step(i, -1, results.length));
            } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && onSide && results[idx]) {
              e.preventDefault();
              onSide(results[idx]!, e.key === "ArrowLeft" ? -1 : 1);
            } else if (e.key === "Enter" && results[idx]) {
              e.preventDefault();
              onPick(results[idx]!, q);
            }
          }}
          placeholder={placeholder}
        />
        <div className="qo-list" ref={listRef}>
          {results.map((t, i) => (
            <button
              key={keyOf(t)}
              className={`qo-item cmd-item ${i === idx ? "active" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => onPick(t, q)}
            >
              {row(t, i === idx, q)}
            </button>
          ))}
          {results.length === 0 && <div className="dock-empty">{empty}</div>}
        </div>
      </div>
    </div>
  );
}

const byName = (needle: string, ...names: Array<string | undefined>) => {
  const n = needle.trim().toLowerCase();
  return !n || names.some((x) => x?.toLowerCase().includes(n));
};

/** dark / light / follow system — previews the slot each would paint */
function AppearancePicker({ state, dispatch, sock }: { state: State; dispatch: Dispatch; sock: Sock }) {
  const prefs = state.themePrefs;
  const modes: ThemePrefs["mode"][] = ["dark", "light", "system"];
  const slotName = (m: ThemePrefs["mode"]) =>
    state.themes.find((t) => t.id === prefs[effectiveKind({ ...prefs, mode: m }, state.systemDark)])?.name ?? "";
  return (
    <ListPicker
      items={modes}
      filter={(ms, q) => ms.filter((m) => byName(q, appearanceLabel[m]))}
      keyOf={(m) => m}
      initialIndex={(ms) => ms.indexOf(prefs.mode)}
      onActive={(m) =>
        dispatch({
          a: "preview-theme",
          theme: m ? resolveTheme({ ...prefs, mode: m }, state.themes, state.systemDark) : null,
        })
      }
      onPick={(m) => {
        sock?.send({ t: "set-theme", prefs: { ...prefs, mode: m } });
        dispatch({ a: "close" });
      }}
      onBack={() => dispatch({ a: "close", back: true })}
      placeholder="light/dark mode · ↑↓ preview · enter keeps · esc reverts"
      row={(m) => (
        <>
          <span className="cmd-label">
            {m === prefs.mode ? "● " : ""}
            {appearanceLabel[m]}
          </span>
          <span className="cmd-hint">
            {m === "system" ? `${state.systemDark ? "dark" : "light"} now · ${slotName(m)}` : slotName(m)}
          </span>
        </>
      )}
    />
  );
}

const sourceOf = (t: Theme) => (t.source === "file" ? "~/.orchardist/themes" : t.source === "vscode" ? "VS Code" : "");

/** theme picker. Main mode lists families (a dark/light pair is one row; ←→ peeks at the other
 * variant, enter fills both slots and appearance stays as set). Slot overrides list single themes of that kind. */
function ThemePicker({ state, dispatch, sock }: { state: State; dispatch: Dispatch; sock: Sock }) {
  const slot = state.overlay?.kind === "theme" ? state.overlay.slot : "theme";
  const prefs = state.themePrefs;
  const nowKind = effectiveKind(prefs, state.systemDark);
  const selectedId = prefs[slot === "theme" ? nowKind : slot];
  const close = () => dispatch({ a: "close" });
  const back = () => dispatch({ a: "close", back: true });
  const preview = (t: Theme | null) => dispatch({ a: "preview-theme", theme: t });

  // ←→ picks a column (null = whatever appearance says) and it sticks as ↑↓ walks the rows, so
  // "browse the light variants" is one keypress; a family missing that kind shows what it has
  const [active, setActive] = useState<ThemeFamily | null>(null);
  const [peek, setPeek] = useState<"dark" | "light" | null>(null);
  const previewOf = (f: ThemeFamily, k: "dark" | "light" | null) => f[k ?? nowKind] ?? f.dark ?? f.light ?? null;
  const families = useMemo(() => themeFamilies(state.themes), [state.themes]);
  useEffect(() => {
    if (slot === "theme") preview(active ? previewOf(active, peek) : null);
  }, [active, peek]);

  if (slot !== "theme") {
    return (
      <ListPicker
        items={state.themes.filter((t) => t.kind === slot)}
        filter={(ts, q) => ts.filter((t) => byName(q, t.name, t.id))}
        keyOf={(t) => t.id}
        initialIndex={(ts) => ts.findIndex((t) => t.id === selectedId)}
        onActive={preview}
        onPick={(t) => {
          sock?.send({ t: "set-theme", prefs: { ...prefs, [slot]: t.id } });
          close();
        }}
        onBack={back}
        placeholder={`${slot} slot override · ↑↓ preview · enter keeps · esc reverts`}
        empty="no matching theme"
        row={(t) => (
          <>
            <span className="cmd-label">
              {t.id === selectedId ? "● " : ""}
              {t.name}
            </span>
            <span className="cmd-hint">{sourceOf(t)}</span>
          </>
        )}
      />
    );
  }

  return (
    <ListPicker
      items={families}
      filter={(fs, q) => fs.filter((f) => byName(q, f.name, f.dark?.name, f.light?.name))}
      keyOf={(f) => f.name + (f.dark?.id ?? f.light?.id)}
      initialIndex={(fs) => fs.findIndex((f) => f.dark?.id === selectedId || f.light?.id === selectedId)}
      onActive={setActive}
      onSide={(f) => {
        if (f.dark && f.light) setPeek((previewOf(f, peek)?.kind ?? nowKind) === "dark" ? "light" : "dark");
      }}
      onPick={(f) => {
        sock?.send({ t: "set-theme", prefs: pickFamily(prefs, f) });
        close();
      }}
      onBack={back}
      placeholder="theme · ↑↓ preview · ←→ dark/light · enter keeps · esc reverts"
      empty="no matching theme"
      row={(f, isActive) => {
        const shown = previewOf(f, isActive ? peek : null);
        const src = sourceOf(f.dark ?? f.light!);
        const current = f.dark?.id === selectedId || f.light?.id === selectedId;
        return (
          <>
            <span className="cmd-label">
              {current ? "● " : ""}
              {f.name}
            </span>
            <span className="cmd-hint theme-kinds">
              {src && <span>{src}</span>}
              <span className={`kind ${isActive && shown?.kind === "dark" ? "on" : ""}`}>{f.dark ? "dark" : ""}</span>
              <span className={`kind ${isActive && shown?.kind === "light" ? "on" : ""}`}>
                {f.light ? "light" : ""}
              </span>
            </span>
          </>
        );
      }}
    />
  );
}

function CommandRow({ c, active, q, onRun }: { c: Command; active: boolean; q: string; onRun: () => void }) {
  return (
    <button className={`qo-item cmd-item ${active ? "active" : ""}`} onClick={onRun}>
      <span className="cmd-label">{markHits(c.label, q ? commandHits(c.label, q) : null, 0)}</span>
      {c.hint && <span className="cmd-hint">{c.hint}</span>}
    </button>
  );
}

function CommandPalette({
  commands,
  onClose,
  initialQuery = "",
  onSub,
}: {
  commands: Command[];
  onClose: () => void;
  initialQuery?: string;
  /** a sub-picker command is about to run: remember the query so esc there comes back here */
  onSub?: (q: string) => void;
}) {
  return (
    <ListPicker
      items={commands}
      filter={filterCommands}
      keyOf={(c) => c.id}
      onPick={(c, q) => {
        if (c.sub && onSub) onSub(q);
        else onClose();
        c.run();
      }}
      onBack={onClose}
      placeholder="run a command…"
      initialQuery={initialQuery}
      empty="no matching command"
      row={(c, _active, q) => (
        <>
          <span className="cmd-label">{markHits(c.label, q.trim() ? commandHits(c.label, q.trim()) : null, 0)}</span>
          {c.hint && <span className="cmd-hint">{c.hint}</span>}
        </>
      )}
    />
  );
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

function Center({
  state,
  active,
  dispatch,
  sock,
  repo,
}: {
  state: State;
  active: WorktreeStatus | null;
  dispatch: Dispatch;
  sock: Sock;
  repo: State["repos"][number] | null;
}) {
  // one persistent iframe per visited worktree: switching is a display toggle
  // (instant, and each preview keeps its app state + HMR socket while hidden)
  const [mounted, setMounted] = useState<string[]>([]);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  // each preview's origin: the only target we post to and the only sender we accept for that frame
  const originRefs = useRef(new Map<string, string>());
  const stateRef = useRef(state);
  stateRef.current = state;

  // let the rest of the shell post commands into preview iframes
  useEffect(() => {
    previewBus.post = (id, m) =>
      frameRefs.current
        .get(id)
        ?.contentWindow?.postMessage({ __orchardist: true, ...m }, originRefs.current.get(id) ?? "*");
    previewBus.broadcast = (m) => {
      for (const [id, f] of frameRefs.current)
        f.contentWindow?.postMessage({ __orchardist: true, ...m }, originRefs.current.get(id) ?? "*");
    };
  }, []);

  // attribute bridge messages to their worktree via event.source
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!(e.data as { __orchardist?: boolean } | null)?.__orchardist) return;
      for (const [id, frame] of frameRefs.current) {
        if (frame.contentWindow === e.source) {
          if (e.origin !== originRefs.current.get(id)) return;
          const d = parseBridgeMsg(e.data);
          if (!d) return;
          if (d.type === "key") {
            // bridge chord forwarding: replay as a real keydown so App's handler sees it
            window.dispatchEvent(new KeyboardEvent("keydown", { key: d.key, metaKey: true, shiftKey: !!d.shift }));
          } else if (d.type === "hmr") dispatch({ a: "hmr", id });
          else if (d.type === "loaded") {
            previewBus.post(id, bridgeThemeMsg(currentTheme(stateRef.current)));
            dispatch({ a: "hmr", id });
            dispatch({ a: "page", id, url: d.url, title: d.title, fresh: true });
          } else if (d.type === "highlight-miss") {
            console.warn(
              `[orchardist] highlight miss on ${d.path}: ${d.fileMatched} elements from this file, ` +
                `${d.withSource} elements with source info on page, ranges=${JSON.stringify(d.ranges)}`,
            );
          } else if (d.type === "navigated") dispatch({ a: "page", id, url: d.url });
          else if (d.type === "page-error") {
            const where = d.source ? ` (${relFile(d.source)}:${d.line ?? "?"})` : "";
            dispatch({ a: "page", id, error: `${d.message}${where}` });
          } else if (d.type === "picked") {
            const { type: _t, ...pick } = d;
            dispatch({ a: "picked", pick: { worktreeId: id, ...pick } });
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
      previewBus.post(req.id, { type: "reload" });
    }, 1200);
    return () => clearTimeout(timer);
  }, [state.reloadReq?.n]);
  const activeReady = active && active.procs.length > 0 && active.procs.some((p) => p.status !== "stopped");
  useEffect(() => {
    if (active && activeReady && !mounted.includes(active.worktree.id)) {
      setMounted((m) => [...m, active.worktree.id]);
    }
  }, [active?.worktree.id, activeReady]);

  const logs = active ? (state.local[active.worktree.id]?.log ?? []) : [];
  const frames = state.worktrees.filter((w) => mounted.includes(w.worktree.id));

  // editor pane: draggable height + full-height toggle, persisted
  const centerRef = useRef<HTMLDivElement>(null);
  const [diffH, setDiffH] = useState(() => {
    const n = Number(localStorage.getItem(STORAGE.diffHeight));
    return Number.isFinite(n) && n >= 120 ? n : 0; // 0 = default 45%
  });
  const [diffFull, setDiffFull] = useState(() => localStorage.getItem(STORAGE.diffFull) === "1");
  const toggleFull = () => {
    setDiffFull((f) => {
      localStorage.setItem(STORAGE.diffFull, f ? "0" : "1");
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
      localStorage.setItem(STORAGE.diffHeight, String(Math.round(h)));
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
                if (el) {
                  frameRefs.current.set(w.worktree.id, el);
                  originRefs.current.set(w.worktree.id, new URL(previewUrl(w.worktree.proxyPort)).origin);
                } else {
                  frameRefs.current.delete(w.worktree.id);
                  originRefs.current.delete(w.worktree.id);
                }
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
      {state.overlay?.kind === "quick-open" && active && (
        <QuickOpen
          paths={state.local[active.worktree.id]?.files ?? []}
          status={state.local[active.worktree.id]?.git?.files ?? []}
          commands={buildCommands(state, dispatch, sock, active, repo)}
          onPick={(path) => {
            sock?.send({ t: "file-diff", worktreeId: active.worktree.id, path });
            dispatch({ a: "close" });
          }}
          onClose={() => dispatch({ a: "close" })}
          initialQuery={state.paletteReturn?.mode === "quick-open" ? state.paletteReturn.q : ""}
          onSub={(q) => dispatch({ a: "palette-return", v: { mode: "quick-open", q } })}
        />
      )}
      {state.overlay?.kind === "search" && active && (
        <SearchPalette
          worktreeId={active.worktree.id}
          results={state.local[active.worktree.id]?.search ?? null}
          onQuery={(q) => sock?.send({ t: "search", worktreeId: active.worktree.id, query: q })}
          onPick={(hit) => {
            dispatch({ a: "goto-line", v: { worktreeId: active.worktree.id, path: hit.path, line: hit.line } });
            sock?.send({ t: "file-diff", worktreeId: active.worktree.id, path: hit.path });
            if (!state.leftOpen) dispatch({ a: "toggle-left" });
            dispatch({ a: "close" });
          }}
          onClose={() => dispatch({ a: "close" })}
        />
      )}
      {state.overlay?.kind === "keys" && (
        <KeysHelp state={state} dispatch={dispatch} onClose={() => dispatch({ a: "close" })} />
      )}
      {state.overlay?.kind === "theme" && <ThemePicker state={state} dispatch={dispatch} sock={sock} />}
      {state.overlay?.kind === "appearance" && <AppearancePicker state={state} dispatch={dispatch} sock={sock} />}
      {state.overlay?.kind === "commands" && (
        <CommandPalette
          commands={buildCommands(state, dispatch, sock, active, repo)}
          onClose={() => dispatch({ a: "close" })}
          initialQuery={state.paletteReturn?.mode === "commands" ? state.paletteReturn.q : ""}
          onSub={(q) => dispatch({ a: "palette-return", v: { mode: "commands", q } })}
        />
      )}
      {state.overlay?.kind === "prompt" && repo && (
        <PromptOverlay
          onSubmit={(text, variants, batch) => {
            if (batch) {
              sock?.send({ t: "batch-worktrees", repoId: repo.id, prompt: text });
            } else if (variants > 1) {
              const group = Math.random().toString(36).slice(2, 10);
              for (let i = 0; i < variants; i++) {
                sock?.send({
                  t: "create-worktree",
                  clientId: state.clientId,
                  repoId: repo.id,
                  prompt: text,
                  variant: { group, index: i + 1, of: variants },
                });
              }
            } else {
              sock?.send({ t: "create-worktree", clientId: state.clientId, repoId: repo.id, prompt: text });
            }
            dispatch({ a: "close" });
            // the agent starts talking in the chat panel — make sure it's on screen
            if (!state.rightOpen) dispatch({ a: "toggle-right" });
          }}
          onClose={() => dispatch({ a: "close" })}
        />
      )}
    </div>
  );
}

function DiffView({
  diff,
  state,
  dispatch,
  sock,
  height,
  full,
  onToggleFull,
  onDragStart,
}: {
  diff: NonNullable<State["diff"]>;
  state: State;
  dispatch: Dispatch;
  sock: Sock;
  height: number | string;
  full: boolean;
  onToggleFull: () => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const wt = state.worktrees.find((w) => w.worktree.id === diff.worktreeId);
  const absPath = wt ? `${wt.worktree.path}/${diff.path}` : diff.path;
  // warm the line-offset/ranges cache so line-hover highlights align
  useEffect(() => {
    if (!state.local[diff.worktreeId]?.changedRanges[diff.path]) {
      sock?.send({ t: "changed-ranges", worktreeId: diff.worktreeId, path: diff.path });
    }
  }, [diff.worktreeId, diff.path]);
  const lineOff = state.local[diff.worktreeId]?.changedRanges[diff.path]?.offset ?? 0;
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
        <button onClick={() => dispatch({ a: "close-diff" })} {...tip("Close", "esc")}>
          ✕
        </button>
      </div>
      <Suspense fallback={<div className="empty">loading diff…</div>}>
        <MonacoDiff
          before={diff.before}
          after={diff.after}
          path={diff.path}
          line={diff.line}
          theme={currentTheme(state)}
          onSave={(content) => sock?.send({ t: "write-file", worktreeId: diff.worktreeId, path: diff.path, content })}
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

function OpenInMenu({ absPath, onReveal }: { absPath: string; onReveal?: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    // clicks inside the preview iframe never bubble here, but they do steal focus
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", close);
    };
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
      procs: Object.fromEntries(
        procs.filter((p) => p.name.trim() && p.cmd.trim()).map((p) => [p.name.trim(), p.cmd.trim()]),
      ),
      setup: setup
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
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
            <button {...tip("Remove")} onClick={() => setProcs(procs.filter((_, j) => j !== i))}>
              ✕
            </button>
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
        <label
          className="cfg-exclusive"
          data-tip="For apps that can't take $PORT: only the focused worktree's processes run"
        >
          <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} />
          <span>exclusive — commands can't honor $PORT, run only the focused worktree</span>
        </label>
        <div className="cfg-actions">
          <span className="cfg-note">saved to orchardist.json in the repo</span>
          <button className="ship-btn" disabled={procs.every((p) => !p.name.trim() || !p.cmd.trim())} onClick={start}>
            start ▸
          </button>
        </div>
      </div>
    </div>
  );
}

/** ⌘P: fuzzy file jump; a leading `>` switches the same box to the command palette (editor convention) */
function QuickOpen({
  paths,
  status,
  commands,
  onPick,
  onClose,
  initialQuery = "",
  onSub,
}: {
  paths: string[];
  status: GitFileStatus[];
  commands: Command[];
  onPick: (path: string) => void;
  onClose: () => void;
  initialQuery?: string;
  onSub?: (q: string) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [idx, setIdx] = useState(0);
  const cmdMode = q.startsWith(">");

  // changed files lead an empty query (same order as the changes panel);
  // once typing, it's fuzzy order with a small nudge for changed files
  const results = useMemo(() => (cmdMode ? [] : rankFiles(paths, status, q).rows), [q, paths, status, cmdMode]);
  const cmdResults = useMemo(() => (cmdMode ? filterCommands(commands, q.slice(1)) : []), [q, commands, cmdMode]);
  const count = cmdMode ? cmdResults.length : results.length;
  const runCmd = (c: Command) => {
    if (c.sub && onSub) onSub(q);
    else onClose();
    c.run();
  };

  useEffect(() => setIdx(0), [q]);

  return (
    <div className="prompt-overlay" onClick={onClose}>
      <div className="prompt-box quick-open" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => step(i, 1, count));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => step(i, -1, count));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (cmdMode) {
                if (cmdResults[idx]) runCmd(cmdResults[idx]!);
              } else if (results[idx]) onPick(results[idx]!.path);
            }
          }}
          placeholder="jump to file · type > for commands"
        />
        <div className="qo-list">
          {cmdMode
            ? cmdResults.map((c, i) => (
                <CommandRow key={c.id} c={c} active={i === idx} q={q.slice(1).trim()} onRun={() => runCmd(c)} />
              ))
            : results.map((r, i) => {
                const [name, dir] = splitPath(r.path);
                const hits = q.trim() ? matchPositions(r.path, q.trim()) : null;
                return (
                  <button
                    key={r.path}
                    className={`qo-item qo-file ${i === idx ? "active" : ""}`}
                    onClick={() => onPick(r.path)}
                  >
                    <span className={`xy ${r.status ? xyClass(r.status.xy) : ""}`}>
                      {r.status ? xyLetter(r.status.xy) : ""}
                    </span>
                    <span className="name">{markHits(name, hits, dir.length)}</span>
                    <span className="dir">
                      {dir && (
                        <>
                          {"\u200e"}
                          {markHits(dir, hits, 0)}
                          {"\u200e"}
                        </>
                      )}
                    </span>
                    {r.status && <LineCounts f={r.status} />}
                  </button>
                );
              })}
          {count === 0 && <div className="dock-empty">{cmdMode ? "no matching command" : "no matches"}</div>}
        </div>
      </div>
    </div>
  );
}

/** wrap the matched characters of one path segment (which starts at `offset` within the full path) */
function markHits(text: string, hits: number[] | null, offset: number) {
  if (!hits) return text;
  const set = new Set(hits.map((h) => h - offset));
  const out: Array<string | JSX.Element> = [];
  let run = "";
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (run) out.push(run);
      run = "";
      out.push(
        <b key={i} className="hit">
          {text[i]}
        </b>,
      );
    } else run += text[i];
  }
  if (run) out.push(run);
  return out;
}

// command labels are prose, not paths: a character may only skip ahead to the start of a word,
// so "theem" can't scavenge t·h·e·e·m out of "switch to you-ve-hit-your-session-limit"
function commandScore(hay: string, needle: string): number {
  const hits = commandHits(hay, needle);
  if (!hits) return 0;
  let score = 0,
    streak = 0,
    prev = -1;
  for (const found of hits) {
    streak = found === prev + 1 ? streak + 1 : 1;
    score += streak + (commandWordStart(hay, found) ? 3 : 0);
    prev = found;
  }
  return score + Math.max(0, 40 - hay.length / 4);
}
const commandWordStart = (hay: string, i: number) => i === 0 || /[\s:\-–—/.(]/.test(hay[i - 1]!);
/** positions each needle character lands on under the word-start rule (case-insensitive); null when no match */
function commandHits(label: string, needle: string): number[] | null {
  const hay = label.toLowerCase(),
    out: number[] = [];
  let hi = 0;
  for (const ch of needle.toLowerCase()) {
    let found = -1;
    if (hay[hi] === ch) found = hi;
    else if (ch === " ")
      found = hay.indexOf(" ", hi); // a typed space lands on the next word gap
    else
      for (let i = hay.indexOf(ch, hi); i !== -1; i = hay.indexOf(ch, i + 1)) {
        if (commandWordStart(hay, i)) {
          found = i;
          break;
        }
      }
    if (found === -1) return null;
    out.push(found);
    hi = found + 1;
  }
  return out;
}

function PromptOverlay({
  onSubmit,
  onClose,
}: {
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
                <button key={n} className={`variant-chip ${variants === n ? "on" : ""}`} onClick={() => setVariants(n)}>
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

function RightDock({
  state,
  active,
  sock,
  dispatch,
  width,
}: {
  state: State;
  active: WorktreeStatus | null;
  sock: Sock;
  dispatch: Dispatch;
  width: number;
}) {
  const items = active ? (state.local[active.worktree.id]?.chat ?? []) : [];
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
  // picking happens inside the iframe, which takes focus; hand it back to the composer so the
  // user can type about the element straight away (next frame: the dock may be re-appearing)
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!pick) return;
    const f = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(f);
  }, [pick]);
  const buildContext = (): string | undefined => {
    if (!active) return undefined;
    const parts: string[] = [];
    const pc = state.local[active.worktree.id]?.page;
    if (pc?.url) {
      try {
        const u = new URL(pc.url);
        parts.push(`current route: ${u.pathname}${u.search}`);
      } catch {}
    }
    if (pc?.title) parts.push(`page title: ${pc.title}`);
    if (pc?.errors.length) parts.push(`recent console errors:\n${pc.errors.map((e) => `- ${e}`).join("\n")}`);
    if (pick) {
      const where = pick.file
        ? ` defined at ${relFile(pick.file, active.worktree.path)}${pick.line ? `:${pick.line}` : ""}`
        : "";
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
        clientId: state.clientId,
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
            (state.local[active.worktree.id]?.queue ?? []).map((text, i) => (
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
                  {" "}
                  · {relFile(pick.file, active!.worktree.path)}
                  {pick.line ? `:${pick.line}` : ""}
                </span>
              )}
            </span>
            <button {...tip("Remove attachment")} onClick={() => dispatch({ a: "clear-pick" })}>
              ✕
            </button>
          </div>
        )}
        <textarea
          ref={composerRef}
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
          <label
            data-tip={
              isMain
                ? "Unchecked: the agent edits your main working copy directly"
                : "Checked: fork a new worktree from this one instead of continuing here"
            }
          >
            <input type="checkbox" checked={spawnNew} onChange={(e) => setSpawnNew(e.target.checked)} />
            <span>
              new worktree from <b>{active?.worktree.title ?? "—"}</b>
            </span>
          </label>
          <button
            className={`composer-pick ${state.picking ? "rb-on" : ""}`}
            disabled={!active}
            {...tip("Pick an element on the page to attach", chord("pick"))}
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
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: html is DOMPurify-sanitized markdown output
  return <div className="msg-assistant md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ChatItemView({
  item,
  onPickHover,
}: {
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
                  {" "}
                  · {relFile(item.pick.file)}
                  {item.pick.line ? `:${item.pick.line}` : ""}
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
      return (
        <div className="msg-assistant" style={{ color: "var(--red)" }}>
          {item.text}
        </div>
      );
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
  const v = input.file_path ?? input.command ?? input.path ?? input.pattern ?? "";
  return typeof v === "string" ? v : "";
}

/** ⌘⇧F: content search across the active worktree (git grep in the daemon, debounced) */
function SearchPalette({
  worktreeId,
  results,
  onQuery,
  onPick,
  onClose,
}: {
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
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => step(i, 1, hits.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => step(i, -1, hits.length));
            } else if (e.key === "Enter" && hits[idx]) {
              e.preventDefault();
              onPick(hits[idx]!);
            }
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
              <span className="sr-loc">
                {h.path}
                <span className="sr-line">:{h.line}</span>
              </span>
              <span className="sr-text">{h.text}</span>
            </button>
          ))}
          {q.trim().length < 2 && <div className="dock-empty">type at least two characters</div>}
          {q.trim().length >= 2 && !stale && hits.length === 0 && <div className="dock-empty">no matches</div>}
          {q.trim().length >= 2 && stale && hits.length === 0 && <div className="dock-empty">searching…</div>}
          {results?.truncated && !stale && (
            <div className="dock-empty">showing the first {hits.length} — narrow the search</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Firefox owns ⌘⇧P (new private window) before the page sees it; both chords work everywhere
// else, so advertise the one that will actually fire in this browser
const IS_FIREFOX = /Firefox\//.test(navigator.userAgent);
const chord = (id: ChordId) => chordLabel(id, { firefox: IS_FIREFOX });
const KEY_SECTIONS = CHORD_SECTIONS.map((title) => ({
  title,
  rows: CHORDS.filter((c) => c.section === title).map((c): [string, string] => [chord(c.id), c.label]),
}));
/** ? / ⌘/: settings card stacked over the shortcut card — the one non-worktree surface, so global
 * settings live here as well as in the palette; esc from a picker opened here comes back */
function KeysHelp({ state, dispatch, onClose }: { state: State; dispatch: Dispatch; onClose: () => void }) {
  const prefs = state.themePrefs;
  const open = (a: Parameters<Dispatch>[0]) => {
    dispatch({ a: "palette-return", v: { mode: "keys", q: "" } });
    dispatch(a);
  };
  const boxRef = useRef<HTMLDivElement>(null);
  useDismissOutside(boxRef, onClose);
  return (
    <div className="keys-overlay">
      <div className="keys-stack" ref={boxRef}>
        <div className="keys-card settings-card">
          <div className="keys-h">Settings</div>
          <div className="set-row">
            <span className="keys-d">theme</span>
            <button className="set-v" onClick={() => open({ a: "open", overlay: { kind: "theme", slot: "theme" } })}>
              {resolveTheme(prefs, state.themes, state.systemDark).name}
            </button>
          </div>
          <div className="set-row">
            <span className="keys-d">light/dark mode</span>
            <button className="set-v" onClick={() => open({ a: "open", overlay: { kind: "appearance" } })}>
              {appearanceLabel[prefs.mode]}
            </button>
          </div>
        </div>
        <div className="keys-card">
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
    </div>
  );
}

/* every status-bar glyph comes from here — same 16px box, same 1.3 stroke — so
   the row reads as one family (font glyphs each brought their own weight) */
type IconName = "branch" | "chat" | "help" | "zen" | "back" | "forward" | "reload" | "pick";
const ICON_PATHS: Record<IconName, string> = {
  branch:
    "M4.5 5.1v5.8 M11.5 6.6c0 2.6-7 1.6-7 4.3 M4.5 1.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M4.5 10.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z M11.5 3.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2z",
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
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

function StatusBar({
  state,
  active,
  dispatch,
  sock,
  navCenter,
}: {
  state: State;
  active: WorktreeStatus | null;
  dispatch: Dispatch;
  sock: Sock;
  navCenter: number;
}) {
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
  const url = id ? state.local[id]?.page.url : undefined;
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
      {state.zen && <span className="zen-title">{active?.worktree.title ?? "orchardist"}</span>}
      <button
        className={`toggle icon ${state.leftOpen ? "on" : ""}`}
        onClick={() => dispatch({ a: "toggle-left" })}
        {...tip("Changes panel", chord("left"))}
      >
        <Icon name="branch" />
      </button>
      <div className="rb-center" style={{ left: navCenter }}>
        <button
          className="rb-btn rb-nav"
          disabled={!ready}
          {...tip("Back")}
          onClick={() => id && previewBus.post(id, { type: "back" })}
        >
          <Icon name="back" />
        </button>
        <button
          className="rb-btn rb-nav"
          disabled={!ready}
          {...tip("Forward")}
          onClick={() => id && previewBus.post(id, { type: "forward" })}
        >
          <Icon name="forward" />
        </button>
        <button
          className="rb-btn rb-nav rb-reload"
          disabled={!ready}
          {...tip("Reload preview")}
          onClick={() => id && previewBus.post(id, { type: "reload" })}
        >
          <Icon name="reload" />
        </button>
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
        <button
          className="toggle icon keys-btn"
          {...tip("Shortcuts & settings", chord("keys"))}
          onClick={() => dispatch({ a: "toggle", overlay: { kind: "keys" } })}
        >
          <Icon name="help" />
        </button>
        <button
          className={`toggle icon ${state.rightOpen ? "on" : ""}`}
          onClick={() => dispatch({ a: "toggle-right" })}
          {...tip("Chat panel", chord("right"))}
        >
          <Icon name="chat" />
        </button>
        <button
          className="toggle icon keys-btn"
          {...tip("Full-bleed preview", chord("zen"))}
          onClick={() => dispatch({ a: "toggle-zen" })}
        >
          <Icon name="zen" />
        </button>
      </span>
    </div>
  );
}
