import type { WorktreeStatus } from "@orchardist/shared";
import { useCallback, useEffect, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { useActiveId, useWorktrees } from "../../state/selectors.ts";
import { Menu, type MenuItem } from "../../ui/Menu.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { chord, dotClass } from "../util.ts";
import { worktreeActions } from "./worktreeActions.ts";

type MenuState = { at: { x: number; y: number }; id: string; land?: boolean };

/** far-right worktree rail: 40px dot strip, hover peeks the full panel; shift-click / "graft with…"
 * enters a multi-select for grafting, bulk sync and bulk remove */
export function WtRail() {
  const dispatch = useDispatch();
  const sock = useSock();
  const worktrees = useWorktrees();
  const activeId = useActiveId();
  const connected = useStore((s) => s.connected);
  const leftOpen = useStore((s) => s.leftOpen);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
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

  const acts = worktreeActions(sock);
  const menuWt = menu ? (worktrees.find((w) => w.worktree.id === menu.id) ?? null) : null;
  const menuItems = (w: WorktreeStatus, land: boolean | undefined): MenuItem[] => {
    const id = w.worktree.id;
    const merge: MenuItem = {
      label: "merge into main",
      onClick: () => sock?.send({ t: "merge-main", worktreeId: id }),
    };
    const ship: MenuItem = { label: "push + PR", onClick: () => sock?.send({ t: "ship", worktreeId: id }) };
    if (land) return [merge, ship];
    const items: MenuItem[] = [];
    if ((w.dirty ?? 0) > 0 || (w.ahead ?? 0) > 0 || !leftOpen) {
      items.push({
        label: `view changes${(w.dirty ?? 0) > 0 ? ` (${w.dirty})` : ""}`,
        onClick: () => {
          dispatch({ a: "activate", id });
          if (!leftOpen) dispatch({ a: "toggle-left" });
        },
      });
    }
    items.push({ label: "reveal in Finder", onClick: () => sock?.send({ t: "reveal", worktreeId: id }) });
    if (w.worktree.kind !== "main") {
      items.push({ label: "rename…", onClick: () => acts.rename(w) });
      if (w.worktree.variant) items.push({ label: "keep this variant…", onClick: () => acts.pickVariant(w) });
      items.push({
        label: "graft with…",
        onClick: () => {
          setGraftMode(true);
          setSel((s) => (s.includes(id) ? s : [...s, id]));
        },
      });
      items.push(merge, ship, { label: "remove…", danger: true, onClick: () => acts.remove(w) });
    }
    return items;
  };

  return (
    <div className={`wt-rail ${graftMode || menu ? "hold" : ""} ${connected ? "" : "offline"}`}>
      <div className="rail-panel">
        <div className="rail-list">
          {worktrees.map((w) => (
            <button
              key={w.worktree.id}
              className={`wt-item ${w.worktree.id === activeId ? "active" : ""} ${sel.includes(w.worktree.id) ? "sel" : ""} ${menu?.id === w.worktree.id ? "menu-open" : ""}`}
              onClick={(e) => {
                if (graftMode || e.shiftKey) toggleSel(w);
                else dispatch({ a: "activate", id: w.worktree.id });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ at: { x: e.clientX, y: e.clientY }, id: w.worktree.id });
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
                    acts.pickVariant(w);
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
                    if (!leftOpen) dispatch({ a: "toggle-left" });
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
                    setMenu({ at: { x: r.left - 100, y: r.bottom + 4 }, id: w.worktree.id, land: true });
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
                  setMenu({ at: { x: r.left - 140, y: r.bottom + 4 }, id: w.worktree.id });
                }}
              >
                ⋯
              </span>
            </button>
          ))}
          {graftMode && (
            <div className="graft-row">
              <button
                className="btn bulk-btn combine-btn"
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
                className="btn bulk-btn"
                disabled={!sel.some((id) => (worktrees.find((w) => w.worktree.id === id)?.behind ?? 0) > 0)}
                data-tip="Pull main into every selected worktree that's behind"
                onClick={() => {
                  for (const id of sel) {
                    const w = worktrees.find((x) => x.worktree.id === id);
                    if ((w?.behind ?? 0) > 0) sock?.send({ t: "sync-main", worktreeId: id });
                  }
                  cancelGraft();
                }}
              >
                ↓ sync
              </button>
              <button
                className="btn bulk-btn danger"
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
              <button className="btn bulk-btn" {...tip("Cancel", "esc")} onClick={cancelGraft}>
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
              <span className="kbd-hint nw-full">{chord("new")}</span>
            </button>
          )}
        </div>
        <div
          className={`rail-foot ${connected ? "" : "off"}`}
          data-tip={connected ? "Connected to daemon" : "Reconnecting to daemon"}
        >
          <span className="nw-full conn-label">{connected ? "connected" : "reconnecting…"}</span>
          <span className="conn-dot" />
        </div>
        {menu && menuWt && <Menu at={menu.at} onClose={closeMenu} items={menuItems(menuWt, menu.land)} />}
      </div>
    </div>
  );
}
