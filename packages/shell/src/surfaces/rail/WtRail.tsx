import {
  canFold,
  canLand,
  canRemove,
  canRename,
  canSync,
  isOwned,
  type OwnedWorktree,
  type WorktreeStatus,
} from "@toyon/shared";
import { type MouseEvent, useCallback, useState } from "react";
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

type MenuState = { at: { x: number; y: number }; id: string };

/** a count in its 3ch column; past three digits the exact number stops meaning anything here */
const count = (n: number) => (n > 999 ? "1k+" : String(n));

/** far-right worktree rail: 40px dot strip, hover peeks the full panel; shift-click / "fold into…"
 * enters a multi-select for folding worktrees into one, bulk sync and bulk remove */
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
  const repoOf = (w: OwnedWorktree) => repos.find((r) => r.id === w.repoId) ?? null;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [discMenu, setDiscMenu] = useState<{ at: { x: number; y: number }; id: string } | null>(null);
  const closeDiscMenu = useCallback(() => setDiscMenu(null), []);
  // the daemon sends absolute paths; ~ is how the person wrote it and how the picker shows it back
  const home = useStore((s) => s.home);
  const wtDirLabel = (d: WorktreeStatus) =>
    home && d.path.startsWith(`${home}/`) ? `~${d.path.slice(home.length)}` : d.path;
  const [foldMode, setFoldMode] = useState(false);
  const [sel, setSel] = useState<string[]>([]);

  const toggleSel = (w: OwnedWorktree) => {
    if (!canFold(w.worktree)) return;
    setFoldMode(true);
    setSel((s) => (s.includes(w.worktree.id) ? s.filter((x) => x !== w.worktree.id) : [...s, w.worktree.id]));
  };
  const cancelFold = () => {
    setFoldMode(false);
    setSel([]);
  };
  useOnChange([foldMode], () => {
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && cancelFold();
    if (foldMode) window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  });

  const acts = worktreeActions(sock, dispatch);
  const menuWt = menu ? (worktrees.find((w) => w.worktree.id === menu.id) ?? null) : null;
  const discMenuRow = discMenu ? (discovered.find((d) => d.id === discMenu.id) ?? null) : null;

  /** A discovered worktree is a directory toyon does not own, so this stays short on purpose.
   * "open a shell here" is a real pty at that path with no runtime behind it, which is why it is
   * phrased as a shell rather than as this worktree's terminal: there are no proc tabs to go with
   * it, because nothing is running.
   * No "remove": the person made this directory outside toyon, and deleting it is the one thing
   * here that cannot be undone. Nothing in the daemon can delete a discovered worktree at all,
   * which is what keeps that true. `git worktree remove` is where it belongs. */
  const discMenuItems = (d: WorktreeStatus): MenuItem[] => {
    const items: MenuItem[] = [];
    if (!d.locked) {
      items.push({
        label: "take over",
        onClick: () => sock?.send({ t: "adopt-worktree", worktreeId: d.id, clientId }),
      });
    }
    // the one write without take-over: the daemon refuses unless the tree is clean
    if (canSync(d) && (d.behind ?? 0) > 0) {
      items.push({
        label: `sync from main (${d.behind} behind)`,
        onClick: () => sock?.send({ t: "sync-main", worktreeId: d.id }),
      });
    }
    items.push({
      label: "open a shell here",
      onClick: () => {
        dispatch({ a: "activate", id: d.id });
        if (!termOpen) dispatch({ a: "toggle-terminal" });
      },
    });
    items.push({ label: "reveal in Finder", onClick: () => sock?.send({ t: "reveal", worktreeId: d.id }) });
    items.push({
      label: "copy path",
      // best effort: a denied clipboard permission is not worth a toast over a path you can read
      onClick: () => void navigator.clipboard?.writeText(d.path).catch(() => {}),
    });
    return items;
  };
  const menuItems = (w: OwnedWorktree): MenuItem[] => {
    const id = w.worktree.id;
    const merge: MenuItem = {
      label: "merge into main",
      onClick: () => shipOp(sock, dispatch, { t: "merge-main", worktreeId: id }),
    };
    const ship: MenuItem = { label: "push + PR", onClick: () => shipOp(sock, dispatch, { t: "ship", worktreeId: id }) };
    const items: MenuItem[] = [];
    // the count on the row is read, not pressed, so the sync it used to offer lives here
    if (canSync(w) && (w.behind ?? 0) > 0) {
      items.push({
        label: `sync from main (${w.behind} behind)`,
        onClick: () => shipOp(sock, dispatch, { t: "sync-main", worktreeId: id }),
      });
    }
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
    if (canRename(w.worktree)) items.push({ label: "rename…", onClick: () => acts.rename(w) });
    if (w.worktree.variant) items.push({ label: "keep this variant…", onClick: () => acts.pickVariant(w) });
    if (canFold(w.worktree)) {
      items.push({
        label: "fold into…",
        onClick: () => {
          setFoldMode(true);
          // on the row you are on it means "fold others into this": nothing to check yet
          setSel((s) => (id === activeId || s.includes(id) ? s : [...s, id]));
        },
      });
    }
    if (canLand(w.worktree)) items.push(merge, ship);
    if (canRemove(w.worktree)) items.push({ label: "remove…", danger: true, onClick: () => acts.remove(w) });
    return items;
  };

  /* The count columns are reserved list-wide, so a row with no dirty files still leaves the dirty
   * column empty and every number sits under the one above it. A column nobody uses is not drawn,
   * and the name takes its width. */
  const all = [...worktrees, ...discovered];
  const cols = {
    dirty: all.some((w) => (w.dirty ?? 0) > 0),
    behind: all.some((w) => (w.behind ?? 0) > 0),
    ahead: all.some((w) => (w.ahead ?? 0) > 0),
  };

  /** One row for both sections. Ownership decides what the row can do, not what it looks like: a
   * found worktree wears the same counts, since they are as real as anyone's, and its menu is the
   * short one. The dot is hollow, which is the one place the row says whose it is.
   *
   * Nothing on the right end of the row does anything but switch. In the strip the pointer lands on
   * the dot, the panel unfurls leftward under it, and a small drift while it opens used to land on
   * the kebab or on a count's verb; the counts are read now and the kebab sits in the control
   * column at the far left, the column the plus and the caret already share. */
  const railRow = (w: WorktreeStatus) => {
    const owned = isOwned(w) ? w : null;
    const id = w.id;
    const menuOpen = owned ? menu?.id === id : discMenu?.id === id;
    const openMenu = (at: { x: number; y: number }) => (owned ? setMenu({ at, id }) : setDiscMenu({ at, id }));
    const under = (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      return { x: r.left, y: r.bottom + 4 };
    };
    const showCheck = owned && foldMode && canFold(owned.worktree) && id !== activeId;
    return (
      <button
        key={id}
        type="button"
        className={cx("row row-edge", owned ? "rail-item" : "row-quiet rail-disc-item", menuOpen && "menu-open")}
        data-state={rowState({ current: id === activeId, checked: sel.includes(id) })}
        // the daemon sends absolute paths; a found row's tip is where it is, since nothing else says
        {...(owned
          ? {}
          : tip(w.locked ? `${wtDirLabel(w)} · held by ${w.lockReason ?? "another tool"}` : wtDirLabel(w)))}
        onClick={(e) => {
          // in fold mode the row you are on is the destination, marked by its edge, and has
          // nothing to check; every other foldable row is a source to check or uncheck. A
          // shift-click on it opens the mode with nothing checked yet.
          if (owned && (foldMode || e.shiftKey)) {
            if (id === activeId) setFoldMode(true);
            else toggleSel(owned);
          } else dispatch({ a: "activate", id });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="rail-gut">
          {showCheck ? (
            <input type="checkbox" className="rail-fold-check" checked={sel.includes(id)} readOnly tabIndex={-1} />
          ) : (
            !foldMode && (
              // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
              <span className="rail-more row-dim" {...tip("Actions")} onClick={(e) => openMenu(under(e))}>
                <Icon name="more" className="icon-inline" />
              </span>
            )
          )}
        </span>
        <span className="branch">{w.name}</span>
        {owned?.worktree.mode && owned.worktree.mode !== "auto" && (
          // auto is the default and says nothing; ask and plan change what happens when you look away
          <span className="rail-badge badge-mode" data-tip={`${owned.worktree.mode} mode: the agent waits for you`}>
            {owned.worktree.mode}
          </span>
        )}
        {owned &&
          (() => {
            // only the non-default profile is worth a tag: it is the one you need to notice
            const repo = repoOf(owned);
            const p = profileOf(owned.worktree, repo);
            return p && p !== repo?.config.defaultProfile ? (
              <span className="rail-badge badge-profile" data-tip={`runs the ${p} profile`}>
                {p}
              </span>
            ) : null;
          })()}
        {owned?.worktree.variant && (
          // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured (notes/STYLES.md, Row)
          <span
            className="rail-badge badge-variant clickable"
            data-tip="Keep this variant, remove the others"
            onClick={(e) => {
              e.stopPropagation();
              acts.pickVariant(owned);
            }}
          >
            <span className="num">
              v{owned.worktree.variant.index}/{owned.worktree.variant.of}
            </span>
            <span className="act">pick</span>
          </span>
        )}
        {/* dirty and ahead in colour: they are the two you act on. Behind is nearly always there and
            nearly always in the hundreds, so as a number it only says "stale", and it says that
            from the quiet tier. The columns say which count is which, so no glyph does. */}
        <span className="rail-counts">
          {cols.dirty && (
            <span className="rail-count badge-dirty" data-tip={w.dirty ? `${w.dirty} uncommitted` : undefined}>
              {w.dirty ? `~${count(w.dirty)}` : ""}
            </span>
          )}
          {cols.behind && (
            <span className="rail-count row-dim" data-tip={w.behind ? `${w.behind} behind main` : undefined}>
              {w.behind ? count(w.behind) : ""}
            </span>
          )}
          {cols.ahead && (
            <span className="rail-count badge-ahead" data-tip={w.ahead ? `${w.ahead} ahead of main` : undefined}>
              {w.ahead ? `+${count(w.ahead)}` : ""}
            </span>
          )}
        </span>
        {w.locked && (
          <span className="rail-disc-lock row-dim">
            <Icon name="lock" className="icon-inline" />
          </span>
        )}
        {(() => {
          // a landing op is out: the dot's slot shows it working, since the op was started from
          // this row and the control that started it may be off screen in the strip. `waiting`
          // still wins: a person being needed outranks a git op that finishes on its own.
          if (shipping[id] && dotClass(w) !== "waiting") return <Spinner size="dot" />;
          // hollow: git knows about it, toyon does not run it, so there is no activity to colour
          if (!owned) return <span className="dot discovered" />;
          // a red dot means a proc died, and the only thing anyone wants next is its log. The
          // dot is the click target because in the collapsed strip it is the whole row you
          // can see; offline the colour is the socket's, not the proc's, so it stays inert.
          const trouble = foldMode || offline ? null : procTrouble(w.procs);
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
                dispatch({ a: "activate", id });
                dispatch({ a: "term-stream", id, stream: trouble.stream });
              }}
            />
          );
        })()}
      </button>
    );
  };

  return (
    <div className={cx("rail", (foldMode || menu || discMenu) && "hold", railOpen && "pinned", offline && "offline")}>
      {/* the rows carry the socket's state, so the explanation hangs off the panel: a row has no
          tip of its own, and the tooltip walks up to the nearest one */}
      <div className="rail-panel" data-tip={offline ? "Lost the daemon; retrying" : undefined}>
        <div className="rail-list">
          {worktrees.map(railRow)}
          {foldMode && (
            <div className="rail-fold">
              {(() => {
                // the row you are on takes the others: it keeps its agent, procs and port, and
                // the checked ones are merged into it and removed
                const target = worktrees.find((w) => w.worktree.id === activeId && canFold(w.worktree));
                const sources = sel.filter((id) => id !== target?.worktree.id);
                const names = sources
                  .map((id) => worktrees.find((w) => w.worktree.id === id)?.worktree.title ?? id)
                  .join(", ");
                return (
                  <>
                    {/* the whole phrase on a line of its own, verb included, so the count button
                        under it is shorthand for a sentence that is right there and "fold" never
                        stands alone; one word per button is also what fits the rail's width */}
                    <div className="rail-fold-into">
                      {target ? (
                        <>
                          fold into <b>{target.worktree.title}</b>
                        </>
                      ) : (
                        "select a worktree to fold into"
                      )}
                    </div>
                    <Button
                      size="md"
                      tone="primary"
                      disabled={!target || sources.length === 0}
                      data-tip={
                        target
                          ? `Merge the checked worktrees into ${target.worktree.title} and remove them`
                          : "Select a worktree to fold into"
                      }
                      onClick={() => {
                        if (!target) return;
                        if (
                          window.confirm(
                            `Fold ${names} into ${target.worktree.title}?\n\nTheir branches are merged in, then their directories and branches are removed.`,
                          )
                        ) {
                          sock?.send({ t: "fold", targetId: target.worktree.id, sourceIds: sources });
                          cancelFold();
                        }
                      }}
                    >
                      fold {sources.length}
                    </Button>
                  </>
                );
              })()}
              <Button
                size="md"
                disabled={!sel.some((id) => (worktrees.find((w) => w.worktree.id === id)?.behind ?? 0) > 0)}
                data-tip="Pull main into every selected worktree that's behind"
                onClick={() => {
                  for (const id of sel) {
                    const w = worktrees.find((x) => x.worktree.id === id);
                    if ((w?.behind ?? 0) > 0) shipOp(sock, dispatch, { t: "sync-main", worktreeId: id });
                  }
                  cancelFold();
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
                    cancelFold();
                  }
                }}
              >
                remove…
              </Button>
              <IconButton icon="close" label="Cancel" hint="esc" onClick={cancelFold} />
            </div>
          )}
          {!foldMode && (
            <button
              className="rail-new"
              data-tip="New worktree"
              data-tip-key={chord("new")}
              onClick={() => dispatch({ a: "open", overlay: { kind: "prompt" } })}
            >
              <span className="rail-gut">
                <Icon name="plus" className="icon-inline" />
              </span>
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
              the fold selection. */}
          {!foldMode && discovered.length > 0 && (
            <>
              <button
                className="rail-disc-head"
                aria-expanded={discOpen}
                {...tip(
                  `${discovered.length} worktree${discovered.length === 1 ? "" : "s"} here that toyon did not make`,
                )}
                onClick={() => dispatch({ a: "toggle-discovered" })}
              >
                <span className="rail-gut">
                  <Icon name="caret" className={cx("icon-inline rail-disc-caret", !discOpen && "shut")} />
                </span>
                <span className="rail-label">discovered · {discovered.length}</span>
              </button>
              {discOpen && discovered.map(railRow)}
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
        {menu && menuWt && <Menu at={menu.at} onClose={closeMenu} items={menuItems(menuWt)} />}
        {discMenu && discMenuRow && (
          <Menu at={discMenu.at} onClose={closeDiscMenu} items={discMenuItems(discMenuRow)} />
        )}
      </div>
    </div>
  );
}
