import { useCallback, useEffect, useRef, useState } from "react";
import { previewBus } from "../../app/previewBus.ts";
import { useSock, useStore } from "../../state/context.tsx";
import { useActive, useActiveId, useLocal } from "../../state/selectors.ts";
import { editorItems, Menu } from "../../ui/Menu.tsx";
import { shiftRanges } from "../util.ts";
import { GitFileRow } from "./GitFileRow.tsx";

/** the changes panel: uncommitted + committed-not-landed files, land buttons, commit box */
export function LeftDock({ width }: { width: number }) {
  const sock = useSock();
  const activeId = useActiveId();
  const active = useActive();
  const local = useLocal(activeId);
  const leftOpen = useStore((s) => s.leftOpen);
  const gitInfo = local.git;
  const files = gitInfo?.files ?? [];
  const committed = gitInfo?.committed ?? [];
  const ahead = gitInfo?.ahead ?? 0;
  const behind = gitInfo?.behind ?? 0;
  const isWt = active && active.worktree.kind !== "main";
  const clean = files.length === 0;
  const [commitMsg, setCommitMsg] = useState("");
  useEffect(() => setCommitMsg(""), [activeId]);

  const commit = () => {
    if (!active || !commitMsg.trim()) return;
    sock?.send({ t: "commit", worktreeId: active.worktree.id, message: commitMsg.trim() });
    setCommitMsg("");
  };

  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; path: string; canDiscard: boolean } | null>(null);
  const closeMenu = useCallback(() => setFileMenu(null), []);

  // hover a changed file -> highlight only its changed lines' elements
  const hoverPathRef = useRef<string | null>(null);
  const ranges = local.changedRanges;
  const hoverFile = useCallback(
    (path: string, entering: boolean) => {
      if (!activeId) return;
      if (!entering) {
        hoverPathRef.current = null;
        previewBus.post(activeId, { type: "highlight-clear" });
        return;
      }
      hoverPathRef.current = path;
      const cached = ranges[path];
      if (cached) previewBus.post(activeId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
      else sock?.send({ t: "changed-ranges", worktreeId: activeId, path });
    },
    [activeId, ranges, sock],
  );
  // the ranges arrive after the hover started: light up then
  useEffect(() => {
    const path = hoverPathRef.current;
    if (!path || !activeId) return;
    const cached = ranges[path];
    if (cached) previewBus.post(activeId, { type: "highlight-file", path, ranges: shiftRanges(cached) });
  }, [ranges, activeId]);

  const open = useCallback(
    (path: string) => activeId && sock?.send({ t: "file-diff", worktreeId: activeId, path }),
    [activeId, sock],
  );
  const ctxUncommitted = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setFileMenu({ x: e.clientX, y: e.clientY, path, canDiscard: true });
  }, []);
  const ctxCommitted = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setFileMenu({ x: e.clientX, y: e.clientY, path, canDiscard: false });
  }, []);

  return (
    <div className={`left-dock ${leftOpen ? "" : "collapsed"}`} style={{ width }}>
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
                  className="btn btn-outline ship-btn"
                  data-tip={`Pull ${behind} commit(s) from main into this worktree`}
                  onClick={() => sock?.send({ t: "sync-main", worktreeId: active.worktree.id })}
                >
                  sync ↓
                </button>
              )}
              {ahead > 0 && (
                <>
                  <button
                    className="btn btn-outline ship-btn"
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
                      className="btn btn-outline ship-btn pr-open"
                      data-tip={`PR open — click to view · ${active.worktree.prUrl}`}
                      onClick={() => window.open(active.worktree.prUrl, "_blank")}
                    >
                      pr open ↗
                    </button>
                  ) : (
                    <button
                      className="btn btn-outline ship-btn"
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
            <GitFileRow key={f.path} f={f} onOpen={open} onContext={ctxUncommitted} onHover={hoverFile} />
          ))}
          <div className="commit-box">
            <input
              className="field"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              placeholder="commit message…"
            />
            <button
              className="btn btn-outline ship-btn"
              disabled={!commitMsg.trim()}
              onClick={commit}
              data-tip="git add -A && git commit"
            >
              commit
            </button>
          </div>
        </>
      )}
      {committed.length > 0 && (
        <>
          <div className="dock-section-title" data-tip="Committed on this branch, not yet on main">
            committed · {committed.length}
          </div>
          {committed.map((f) => (
            <GitFileRow key={`c-${f.path}`} f={f} onOpen={open} onContext={ctxCommitted} onHover={hoverFile} />
          ))}
        </>
      )}
      {clean && committed.length === 0 && <div className="dock-empty">clean</div>}
      {fileMenu && active && (
        <Menu
          at={fileMenu}
          onClose={closeMenu}
          items={[
            ...editorItems(`${active.worktree.path}/${fileMenu.path}`, () =>
              sock?.send({ t: "reveal", worktreeId: active.worktree.id, path: fileMenu.path }),
            ),
            ...(fileMenu.canDiscard
              ? [
                  {
                    label: "discard changes…",
                    danger: true,
                    onClick: () => {
                      if (window.confirm(`Discard uncommitted changes to ${fileMenu.path}?`)) {
                        sock?.send({ t: "discard-file", worktreeId: active.worktree.id, path: fileMenu.path });
                      }
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}
