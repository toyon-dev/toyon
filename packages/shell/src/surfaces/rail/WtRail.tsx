import type { WorktreeStatus } from "@toyon/shared";
import { useCallback, useEffect, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { profileNames, profileOf } from "../../state/profiles.ts";
import { useActiveId, useOffline, useVisibleWorktrees } from "../../state/selectors.ts";
import { Icon } from "../../ui/Icon.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { Menu, type MenuItem } from "../../ui/Menu.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { chord, dotClass, procTrouble } from "../util.ts";
import { worktreeActions } from "./worktreeActions.ts";

type MenuState = { at: { x: number; y: number }; id: string; land?: boolean };

/** far-right worktree rail: 40px dot strip, hover peeks the full panel; shift-click / "graft with…"
 * enters a multi-select for grafting, bulk sync and bulk remove */
export function WtRail() {
  const dispatch = useDispatch();
  const sock = useSock();
  const worktrees = useVisibleWorktrees();
  const activeId = useActiveId();
  // the list only dims: what the socket is doing is the bar's to say, not the rail's
  const offline = useOffline();
  const leftOpen = useStore((s) => s.leftOpen);
  const railOpen = useStore((s) => s.railOpen);
  const termOpen = useStore((s) => s.termOpen);
  const repos = useStore((s) => s.repos);
  const repoOf = (w: WorktreeStatus) => repos.find((r) => r.id === w.worktree.repoId) ?? null;
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
    if (w.worktree.kind !== "spare") {
      items.push({
        label: "open terminal",
        onClick: () => {
          dispatch({ a: "activate", id });
          if (!termOpen) dispatch({ a: "toggle-terminal" });
        },
      });
    }
    items.push({ label: "reveal in Finder", onClick: () => sock?.send({ t: "reveal", worktreeId: id }) });
    // main runs procs too, and is where switching is wanted most; flat items — Menu has no submenus
    const repo = repoOf(w);
    const current = profileOf(w.worktree, repo);
    for (const name of profileNames(repo)) {
      if (name !== current) items.push({ label: `run with ${name}`, onClick: () => acts.setProfile(w, name) });
    }
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
    <div className={`wt-rail ${graftMode || menu ? "hold" : ""} ${railOpen ? "open" : ""} ${offline ? "offline" : ""}`}>
      {/* the rows carry the socket's state, so the explanation hangs off the panel: a row has no
          tip of its own, and the tooltip walks up to the nearest one */}
      <div className="rail-panel" data-tip={offline ? "Lost the daemon; retrying" : undefined}>
        <div className="rail-list">
          {worktrees.map((w) => (
            <button
              key={w.worktree.id}
              className={`wt-item row-edge ${w.worktree.id === activeId ? "active" : ""} ${sel.includes(w.worktree.id) ? "sel" : ""} ${menu?.id === w.worktree.id ? "menu-open" : ""}`}
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
              <span className="branch">
                {w.worktree.kind === "combined" && <Icon name="layers" className="icon-inline" />}
                {w.worktree.title}
              </span>
              {(() => {
                // only the non-default profile is worth a tag: it is the one you need to notice
                const repo = repoOf(w);
                const p = profileOf(w.worktree, repo);
                return p && p !== repo?.config.defaultProfile ? (
                  <span className="row-badge profile-badge" data-tip={`runs the ${p} profile`}>
                    {p}
                  </span>
                ) : null;
              })()}
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
                <Icon name="more" className="icon-inline" />
              </span>
              {(() => {
                // a red dot means a proc died, and the only thing anyone wants next is its log. The
                // dot is the click target because in the collapsed strip it is the whole row you
                // can see; offline the colour is the socket's, not the proc's, so it stays inert.
                const trouble = graftMode || offline ? null : procTrouble(w.procs);
                // the ring is a modifier, not a state: it rides on whatever the dot already says
                const unseen = w.unseen ? " unseen" : "";
                if (!trouble || dotClass(w) !== "crashed") return <span className={`dot ${dotClass(w)}${unseen}`} />;
                return (
                  <span
                    className={`dot crashed clickable${unseen}`}
                    {...tip(trouble.tip)}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ a: "activate", id: w.worktree.id });
                      dispatch({ a: "term-stream", id: w.worktree.id, stream: trouble.stream });
                    }}
                  />
                );
              })()}
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
                <Icon name="layers" className="icon-inline" /> graft {sel.length}
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
                <Icon name="pull" className="icon-inline" /> sync
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
                <Icon name="close" className="icon-inline" />
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
              <Icon name="plus" className="icon-inline nw-plus" />
              <span className="rail-label">new worktree</span>
              <Kbd k={chord("new")} className="kbd-hint" />
              {/* the strip has no left edge to show a plus on, so a second one waits in the dot
                  column and hands off to the one above as the panel opens */}
              <span className="rail-glyph nw-strip">
                <Icon name="plus" />
              </span>
            </button>
          )}
        </div>
        <div className="rail-foot">
          <button
            className={`btn-icon ${railOpen ? "on" : ""}`}
            {...tip("Worktree panel", chord("rail"))}
            onClick={() => dispatch({ a: "toggle-rail" })}
          >
            <Icon name="worktrees" />
          </button>
        </div>
        {menu && menuWt && <Menu at={menu.at} onClose={closeMenu} items={menuItems(menuWt, menu.land)} />}
      </div>
    </div>
  );
}
