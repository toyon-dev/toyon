import type { DiscoveredWorktree, WorktreeStatus } from "@toyon/shared";
import { useCallback, useState } from "react";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { profileNames, profileOf } from "../../state/profiles.ts";
import {
  useActiveId,
  useDiscoveredOpen,
  useOffline,
  useVisibleDiscovered,
  useVisibleWorktrees,
} from "../../state/selectors.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Kbd } from "../../ui/Kbd.tsx";
import { Menu, type MenuItem } from "../../ui/Menu.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { tip } from "../../ui/Tooltip.tsx";
import { chord, dotClass, procTrouble } from "../util.ts";
import { removeWorktrees, shipOp, worktreeActions } from "./worktreeActions.ts";
import "./rail.css";
import { cx } from "../../ui/cx.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { rowState } from "../../ui/rowState.ts";

type MenuState = { at: { x: number; y: number }; id: string; land?: boolean };

/** far-right worktree rail: 40px dot strip, hover peeks the full panel; shift-click / "graft with…"
 * enters a multi-select for grafting, bulk sync and bulk remove */
export function WtRail() {
  const dispatch = useDispatch();
  const sock = useSock();
  const worktrees = useVisibleWorktrees();
  const discovered = useVisibleDiscovered();
  const discOpen = useDiscoveredOpen();
  const clientId = useStore((s) => s.clientId);
  const activeId = useActiveId();
  // the list only dims: what the socket is doing is the bar's to say, not the rail's
  const offline = useOffline();
  const leftOpen = useStore((s) => s.leftOpen);
  const railOpen = useStore((s) => s.railOpen);
  const termOpen = useStore((s) => s.termOpen);
  const repos = useStore((s) => s.repos);
  const shipping = useStore((s) => s.shipping);
  const repoOf = (w: WorktreeStatus) => repos.find((r) => r.id === w.worktree.repoId) ?? null;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [discMenu, setDiscMenu] = useState<{ at: { x: number; y: number }; path: string } | null>(null);
  const closeDiscMenu = useCallback(() => setDiscMenu(null), []);
  // the daemon sends absolute paths; ~ is how the person wrote it and how the picker shows it back
  const home = useStore((s) => s.home);
  const wtDirLabel = (d: DiscoveredWorktree) =>
    home && d.path.startsWith(`${home}/`) ? `~${d.path.slice(home.length)}` : d.path;
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
  useOnChange([graftMode], () => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && cancelGraft();
    if (graftMode) window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  });

  const acts = worktreeActions(sock, dispatch);
  const menuWt = menu ? (worktrees.find((w) => w.worktree.id === menu.id) ?? null) : null;
  const discMenuRow = discMenu ? (discovered.find((d) => d.path === discMenu.path) ?? null) : null;

  /** A discovered worktree is a directory toyon does not own, so this stays short on purpose.
   * "open a shell here" is a real pty at that path with no runtime behind it, which is why it is
   * phrased as a shell rather than as this worktree's terminal: there are no proc tabs to go with
   * it, because nothing is running.
   * No "remove": the person made this directory outside toyon, and deleting it is the one thing
   * here that cannot be undone. Nothing in the daemon can delete a discovered worktree at all,
   * which is what keeps that true. `git worktree remove` is where it belongs. */
  const discMenuItems = (d: DiscoveredWorktree): MenuItem[] => {
    const items: MenuItem[] = [];
    if (!d.locked) {
      items.push({
        label: "take over",
        onClick: () => sock?.send({ t: "adopt-worktree", repoId: d.repoId, path: d.path, clientId }),
      });
    }
    items.push({
      label: "open a shell here",
      onClick: () => {
        dispatch({ a: "activate", id: d.id });
        if (!termOpen) dispatch({ a: "toggle-terminal" });
      },
    });
    items.push({
      label: "reveal in Finder",
      onClick: () => sock?.send({ t: "reveal-discovered", repoId: d.repoId, path: d.path }),
    });
    items.push({
      label: "copy path",
      // best effort: a denied clipboard permission is not worth a toast over a path you can read
      onClick: () => void navigator.clipboard?.writeText(d.path).catch(() => {}),
    });
    return items;
  };
  const menuItems = (w: WorktreeStatus, land: boolean | undefined): MenuItem[] => {
    const id = w.worktree.id;
    const merge: MenuItem = {
      label: "merge into main",
      onClick: () => shipOp(sock, dispatch, { t: "merge-main", worktreeId: id }),
    };
    const ship: MenuItem = { label: "push + PR", onClick: () => shipOp(sock, dispatch, { t: "ship", worktreeId: id }) };
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
    <div className={cx("rail", (graftMode || menu || discMenu) && "hold", railOpen && "pinned", offline && "offline")}>
      {/* the rows carry the socket's state, so the explanation hangs off the panel: a row has no
          tip of its own, and the tooltip walks up to the nearest one */}
      <div className="rail-panel" data-tip={offline ? "Lost the daemon; retrying" : undefined}>
        <div className="rail-list">
          {worktrees.map((w) => (
            <button
              key={w.worktree.id}
              className={cx("row rail-item row-edge", menu?.id === w.worktree.id && "menu-open")}
              data-state={rowState({ current: w.worktree.id === activeId, checked: sel.includes(w.worktree.id) })}
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
                  className="rail-graft-check"
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
                  <span className="rail-badge badge-profile" data-tip={`runs the ${p} profile`}>
                    {p}
                  </span>
                ) : null;
              })()}
              {w.worktree.variant && (
                // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
                <span
                  className="rail-badge badge-variant clickable"
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
                // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
                <span
                  className="rail-badge badge-dirty clickable"
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
                // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
                <span
                  className={cx("rail-badge badge-behind", !shipping[w.worktree.id] && "clickable")}
                  data-tip={shipping[w.worktree.id] === "sync-main" ? "Syncing from main" : "Sync from main"}
                  onClick={(e) => {
                    e.stopPropagation();
                    // the count stays until the daemon's frame replaces it: the dot is what says
                    // the sync is running, and a second click while it does has nothing to send
                    if (!shipping[w.worktree.id]) shipOp(sock, dispatch, { t: "sync-main", worktreeId: w.worktree.id });
                  }}
                >
                  <span className="num">↓{w.behind}</span>
                  <span className="act">sync</span>
                </span>
              )}
              {(w.ahead ?? 0) > 0 && (
                // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
                <span
                  className="rail-badge badge-ahead clickable"
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
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row) */}
              <span
                className="rail-more row-dim"
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
                // a landing op is out: the dot's slot shows it working, since the op was started
                // from this row and the control that started it may be off screen in the strip.
                // `waiting` still wins: a person being needed outranks a git op that finishes on
                // its own.
                if (shipping[w.worktree.id] && dotClass(w) !== "waiting") return <Spinner size="dot" />;
                // the ring is a modifier, not a state: it rides on whatever the dot already says
                const unseen = w.unseen ? " unseen" : "";
                if (!trouble || dotClass(w) !== "crashed") return <span className={`dot ${dotClass(w)}${unseen}`} />;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
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
            <div className="rail-graft">
              <Button
                size="md"
                tone="primary"
                disabled={sel.length < 2}
                data-tip="Preview these worktrees merged together (local octopus merge)"
                onClick={() => {
                  sock?.send({ t: "combine", worktreeIds: sel });
                  cancelGraft();
                }}
              >
                <Icon name="layers" className="icon-inline" /> graft {sel.length}
              </Button>
              <Button
                size="md"
                disabled={!sel.some((id) => (worktrees.find((w) => w.worktree.id === id)?.behind ?? 0) > 0)}
                data-tip="Pull main into every selected worktree that's behind"
                onClick={() => {
                  for (const id of sel) {
                    const w = worktrees.find((x) => x.worktree.id === id);
                    if ((w?.behind ?? 0) > 0) shipOp(sock, dispatch, { t: "sync-main", worktreeId: id });
                  }
                  cancelGraft();
                }}
              >
                <Icon name="pull" className="icon-inline" /> sync
              </Button>
              <Button
                size="md"
                tone="danger"
                disabled={sel.length === 0}
                data-tip="Remove all selected worktrees (branches and changes deleted)"
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${sel.length} worktree(s)?\n\nTheir directories and branches are deleted. Unmerged changes are lost.`,
                    )
                  ) {
                    removeWorktrees(sock, dispatch, sel);
                    cancelGraft();
                  }
                }}
              >
                remove…
              </Button>
              <IconButton icon="close" label="Cancel" hint="esc" onClick={cancelGraft} />
            </div>
          )}
          {!graftMode && (
            <button
              className="rail-new"
              data-tip="New worktree"
              data-tip-key={chord("new")}
              onClick={() => dispatch({ a: "open", overlay: { kind: "prompt" } })}
            >
              <Icon name="plus" className="icon-inline rail-new-plus" />
              <span className="rail-label">new worktree</span>
              <Kbd k={chord("new")} className="rail-new-kbd" />
              {/* the strip has no left edge to show a plus on, so a second one waits in the dot
                  column and hands off to the one above as the panel opens */}
              <span className="rail-glyph rail-new-strip">
                <Icon name="plus" />
              </span>
            </button>
          )}
          {/* Below "new worktree", not above it: the whole section is hidden in the strip (see
              rail.css), so what appears when the panel opens pushes nothing anyone is aiming
              at. The rows are divs, not .rail-item buttons, so a shift-click never drags one into
              the graft selection. */}
          {!graftMode && discovered.length > 0 && (
            <>
              <button
                className="rail-disc-head"
                aria-expanded={discOpen}
                {...tip(
                  `${discovered.length} worktree${discovered.length === 1 ? "" : "s"} here that toyon did not make`,
                )}
                onClick={() => dispatch({ a: "toggle-discovered" })}
              >
                <Icon name="caret" className={`icon-inline rail-disc-caret ${discOpen ? "" : "shut"}`} />
                <span className="rail-label">discovered · {discovered.length}</span>
              </button>
              {discOpen &&
                discovered.map((d) => (
                  <button
                    key={d.path}
                    type="button"
                    className={cx("row row-quiet rail-disc-item row-edge", discMenu?.path === d.path && "menu-open")}
                    data-state={rowState({ current: d.id === activeId })}
                    {...tip(d.locked ? `${wtDirLabel(d)} · held by ${d.lockReason ?? "another tool"}` : wtDirLabel(d))}
                    onClick={() => dispatch({ a: "activate", id: d.id })}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setDiscMenu({ at: { x: e.clientX, y: e.clientY }, path: d.path });
                    }}
                  >
                    <span className="branch">{d.name}</span>
                    {/* no inline "take over": the row opens a pane that explains what it would do
                        and offers it there, and a button inside this button would be invalid */}
                    {d.locked && (
                      <span className="rail-disc-lock row-dim">
                        <Icon name="lock" className="icon-inline" />
                      </span>
                    )}
                    <span className="dot discovered" />
                  </button>
                ))}
            </>
          )}
        </div>
        <div className="rail-foot">
          <IconButton
            icon="worktrees"
            label="Worktree panel"
            hint={chord("rail")}
            on={railOpen}
            onClick={() => dispatch({ a: "toggle-rail" })}
          />
        </div>
        {menu && menuWt && <Menu at={menu.at} onClose={closeMenu} items={menuItems(menuWt, menu.land)} />}
        {discMenu && discMenuRow && (
          <Menu at={discMenu.at} onClose={closeDiscMenu} items={discMenuItems(discMenuRow)} />
        )}
      </div>
    </div>
  );
}
