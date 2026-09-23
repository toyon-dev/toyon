import {
  type ArchivedWorktree,
  canGraft,
  isLead,
  isOwned,
  type OwnedWorktree,
  sentAt,
  type WorktreeStatus,
} from "@toyon/shared";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { archivedItems, archivedState } from "../../state/actions/archive.ts";
import {
  archiveWorktrees,
  discoveredItems,
  shipOp,
  worktreeActions,
  worktreeItems,
} from "../../state/actions/worktree.ts";
import { useDispatch, useSock, useStore } from "../../state/context.tsx";
import { profileOf } from "../../state/profiles.ts";
import {
  useActiveId,
  useArchivedOpen,
  useArchivedPage,
  useDiscoveredOpen,
  useOffline,
  useTouch,
  useVisibleArchived,
  useVisibleDiscovered,
  useVisibleWorktrees,
} from "../../state/selectors.ts";
import { asksSetup, trunkOf } from "../../state/store.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { useContextMenu, useMenu } from "../../ui/menu.ts";
import { Spinner } from "../../ui/Spinner.tsx";
import { type TipPlacement, tip } from "../../ui/Tooltip.tsx";
import { dollars, tokens } from "../chat/usage.ts";
import { recapLine } from "../recap.ts";
import { ago, chord, dotClass, procTrouble, rowLabel, shipLabel, shipShown, stateLabel } from "../util.ts";
import "./rail.css";
import { cx } from "../../ui/cx.ts";
import { useOnChange } from "../../ui/hooks.ts";
import { rowState } from "../../ui/rowState.ts";
import { FOUND_LINE, OFFLINE_LINE, rowLine } from "./rowLine.ts";

/** a count in its 3ch column; past three digits the exact number stops meaning anything here */
const count = (n: number) => (n > 999 ? "1k+" : String(n));

/** Where the rail is standing.
 *
 * `strip` is the desk's: a 40px column of dots at the chat's side of the window, which peeks the
 * full panel toward the centre on hover and can be pinned open.
 *
 * `screen` is the phone's home. The same list and the same rows, because everything a row says is
 * already computed here rather than drawn (stateLabel, recapLine, the path, the counts, the dot),
 * and a second row written by hand would have to work all of it out again. It is the drawer kept
 * open, with no strip to peek from and no pin to press, and each row says under its name what its
 * tip would say on a desk. */
export type RailPlacement = "strip" | "screen";

/** the worktree rail, at the chat's side of the window: 40px dot strip, hover peeks the full panel
 * toward the centre; shift-click / "graft with…" enters a multi-select for grafting, bulk sync and
 * bulk remove. `width` is the panel's, dragged and held by the docks row like a dock's: the column
 * it is while kept open, and the width the peek opens to, so the rail has one size however it is
 * showing. On a phone it is the home screen instead, see RailPlacement, and the window's width is
 * its width. */
export function Rail({ width, placement = "strip" }: { width?: number; placement?: RailPlacement }) {
  const onScreen = placement === "screen";
  // no hover: the kebab that shows on it never shows, so the seat it shares with the time takes a
  // tap for the row's menu, and the strip takes a tap for the pin it would have peeked on
  const touch = useTouch();
  // a row's tip stands off the rail toward the centre, whichever edge the rail is at
  const tipSide: TipPlacement = useStore((s) => s.chatSide) === "left" ? "right" : "left";
  const dispatch = useDispatch();
  const sock = useSock();
  const worktrees = useVisibleWorktrees();
  // the lead (the spare, or main without one) is above the tasks (railOrder.ts): the row new work
  // is typed in. It wears what main itself says, since main is not a row while the spare stands
  // in for it: how far it trails origin, what is uncommitted there.
  const lead = worktrees[0] && isLead(worktrees[0].worktree) ? worktrees[0] : null;
  const tasks = lead ? worktrees.slice(1) : worktrees;
  const trunk = useStore((s) => trunkOf(s, s.activeRepoId));
  /** a row's counts: the lead's are main's own */
  const countsOf = (w: WorktreeStatus): { behind?: number; dirty?: number; ahead?: number } =>
    lead && w.id === lead.id && trunk ? { behind: trunk.behind, dirty: trunk.dirty } : w;
  // the gutter's times read in minutes, and a quiet rail can go a long while without a frame
  const [, setMinute] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setMinute((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const discovered = useVisibleDiscovered();
  const discOpen = useDiscoveredOpen();
  const archived = useVisibleArchived();
  const archOpen = useArchivedOpen();
  // an archived worktree's page is up: its row is the marked one, over the active row underneath
  const archivedPage = useArchivedPage();
  const clientId = useStore((s) => s.clientId);
  const activeRepoId = useStore((s) => s.activeRepoId);
  const connected = useStore((s) => s.connected);
  // the section's count is on the rail before anyone opens it, so ask for the list on the way in;
  // the daemon pushes it again whenever a worktree is archived, restored or deleted
  useEffect(() => {
    if (sock && connected && activeRepoId) sock.send({ t: "list-archived", repoId: activeRepoId });
  }, [sock, connected, activeRepoId]);
  const activeId = useActiveId();
  // offline the dots take the fault colour and every tip names it; the bar says what the socket is doing
  const offline = useOffline();
  const layout = useStore((s) => s.layout);
  const railOpen = useStore((s) => s.railOpen);
  // the worktree walk holds the strip's peek open while its modifier is down (app/keys.ts)
  const railPeek = useStore((s) => s.railPeek);
  // That peek unfurls the panel over the dock beside it, under whatever the pointer is resting
  // on, and from then on the hover would keep the panel open after the key that opened it was
  // let go. So a peek that opened with no pointer on the strip goes quiet: the rail does not
  // answer the pointer (rail.css) until the pointer moves, since a hand that moves it is
  // reaching for the rail, and the hover is that hand's again.
  const railRef = useRef<HTMLDivElement>(null);
  const [quiet, setQuiet] = useState(false);
  useOnChange([railPeek], () => {
    if (railPeek && !onScreen && !touch && !railRef.current?.matches(":hover")) setQuiet(true);
  });
  useEffect(() => {
    if (!quiet) return;
    // the first move seen is the baseline, not a move: a layout change under a resting pointer
    // can be reported as one, and the panel opening is such a change
    let from: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      if (!from) {
        from = { x: e.clientX, y: e.clientY };
        return;
      }
      if (Math.abs(e.clientX - from.x) + Math.abs(e.clientY - from.y) < 3) return;
      setQuiet(false);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [quiet]);
  // ⌘⇧K hands the keyboard to the row marked current so ↑↓ walk on from there; only a bump seen
  // after mount counts
  const focusReq = useStore((s) => s.focusRail);
  const answered = useRef(focusReq);
  const listRef = useRef<HTMLDivElement>(null);
  useOnChange([focusReq], () => {
    if (focusReq === answered.current) return;
    answered.current = focusReq;
    const f = requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>('[data-state~="current"]')?.focus(),
    );
    return () => cancelAnimationFrame(f);
  });
  const repos = useStore((s) => s.repos);
  const shipping = useStore((s) => s.shipping);
  const repoOf = (w: OwnedWorktree) => repos.find((r) => r.id === w.repoId) ?? null;
  const cm = useContextMenu("rail");
  // the one menu, read here for two things: the peek stays open while the menu is the rail's, and
  // the row it is about stays lifted while the pointer is over the menu rather than the row
  const menu = useMenu();
  // the daemon sends absolute paths; ~ is how the person wrote it and how the picker shows it back
  const home = useStore((s) => s.home);
  const wtDirLabel = (d: WorktreeStatus) => {
    const p = d.worktree ? d.worktree.path : d.path;
    return home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
  };
  // Every row's tip is one shape: the state in words with its dot, then the branch with the figures
  // at the far edge, then a line of detail when there is one. The branch is what the row never
  // shows, and a toyon worktree's directory is an id that says nothing; the path itself is the
  // menu's. The lead's row goes by its branch, so its name puts the project ahead of it.
  const nameOf = (d: WorktreeStatus) =>
    isOwned(d) && isLead(d.worktree)
      ? [repoOf(d)?.name, rowLabel(d, repoOf(d))].filter(Boolean).join(" · ")
      : (d.branch ?? d.name);
  // the aside: what the agent has cost and filled so far, on the branch's line and nowhere else,
  // so the figures are found in one place
  const figuresOf = (d: WorktreeStatus) => {
    const u = d.usage;
    const parts = [u?.cost !== undefined ? dollars(u.cost) : null, u ? `${tokens(u.used)} of ${tokens(u.size)}` : null];
    return parts.some(Boolean) ? parts.filter(Boolean).join(" · ") : undefined;
  };

  const [graftMode, setGraftMode] = useState(false);
  const [sel, setSel] = useState<string[]>([]);

  const toggleSel = (w: OwnedWorktree) => {
    if (!canGraft(w.worktree)) return;
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
  const deps = { sock, dispatch };
  const graftWith = (id: string) => {
    setGraftMode(true);
    // on the row you are on it means "graft others onto this": nothing to check yet
    setSel((s) => (id === activeId || s.includes(id) ? s : [...s, id]));
  };
  /** what a row can do: the long list for ours, the short one for a found worktree */
  const rowItems = (w: WorktreeStatus) =>
    isOwned(w)
      ? worktreeItems(w, repoOf(w), { layout, shipping }, deps, { graft: graftWith, hostname: location.hostname })
      : discoveredItems(w, { clientId }, deps, location.hostname);

  /* the archive keeps its own count column, reserved list-wide the way the worktrees' are, and not
     drawn at all when no archived row has a number to put in it */
  const archCounts = archived.some((a) => (a.dirty ?? 0) > 0);

  /** An archived worktree, kept with its chat. It runs nothing, so it reads a rung down like a found
   * row and its dot's seat is blank: a seat rather than nothing, so its name starts where every
   * other name does when the dot leads the row. One that archived itself has a clock there, whose
   * hover says why. The gutter says how long ago it was archived. A
   * click opens its page in the
   * centre, the way a found row's does, and the restore button is there: a row that restored on
   * its own click was too easy to hit on the way past. Its menu (the kebab or a right-click) has
   * restore too, with the rest.
   *
   * One line, on both frames. The archive is the one section that only grows, and what the row does
   * not say (what it cost, whether it merged) is on the page a tap away. */
  const archivedRow = (a: ArchivedWorktree) => (
    <button
      key={a.id}
      type="button"
      className={cx(
        "row row-edge row-quiet rail-disc-item rail-arch-item",
        menu?.owner === "rail" && menu.key === a.id && "menu-open",
      )}
      data-state={rowState({ current: archivedPage?.id === a.id })}
      {...tip(archivedState(a), undefined, {
        placement: tipSide,
        name: a.branch,
        aside: a.cost !== undefined ? dollars(a.cost) : undefined,
      })}
      onClick={() => dispatch({ a: "open-archived", id: a.id })}
      {...cm.contextMenu(() => archivedItems(a, clientId, deps), a.id)}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: on touch the whole seat opens the menu the kebab in it opens, since the kebab shows on a hover that never comes; the row menu carries the same actions for the keyboard */}
      <span
        className="rail-gut"
        onClick={
          touch
            ? (e) => {
                e.stopPropagation();
                cm.openUnder(e.currentTarget, () => archivedItems(a, clientId, deps), a.id);
              }
            : undefined
        }
      >
        <span className="rail-at row-dim">{ago(a.archivedAt)}</span>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu carries the same actions for the keyboard */}
        <span
          className="rail-more"
          {...tip("Actions")}
          onClick={(e) => {
            e.stopPropagation();
            cm.openUnder(e.currentTarget, () => archivedItems(a, clientId, deps), a.id);
          }}
        >
          <Icon name="more" />
        </span>
      </span>
      <span className="branch">{a.title}</span>
      {/* the work it was removed with, in the column the live rows count in, so a glance down the
          rail reads one kind of number. Quiet rather than the dirty colour: nothing here is yours
          to act on until the worktree is restored. */}
      {archCounts && (
        <span className="rail-counts">
          <span className="rail-count row-dim" data-tip={a.dirty ? `${a.dirty} uncommitted, kept` : undefined}>
            {a.dirty ? `~${count(a.dirty)}` : ""}
          </span>
        </span>
      )}
      {a.auto ? (
        <span
          className="rail-glyph rail-auto row-dim"
          {...tip(`Archived automatically: ${a.auto}`, undefined, { placement: tipSide })}
        >
          <Icon name="clock" className="icon-inline" />
        </span>
      ) : (
        <span className="dot" />
      )}
      {/* the time the control column carries on the desk, where a screen has no column for it */}
      {onScreen && <span className="rail-at rail-at-end row-dim">{ago(a.archivedAt)}</span>}
    </button>
  );

  /* The count columns are reserved list-wide, so every number sits under the one above it. A column
   * nobody uses is not drawn, and the name takes its width. */
  const all = [...worktrees, ...discovered].map(countsOf);
  const kinds = (["dirty", "behind", "ahead"] as const).filter((k) => all.some((w) => (w[k] ?? 0) > 0));
  /** The columns a row draws. The name is the one item that stretches, so what follows it is
   * anchored to the far edge: a trailing empty column is what keeps a row's number under the one
   * above, and an empty column between the name and the row's first number holds nothing in place.
   * That one is not drawn, so a long name runs on into it instead of stopping short of a blank. */
  const drawn = (counts: ReturnType<typeof countsOf>) => {
    const first = kinds.findIndex((k) => (counts[k] ?? 0) > 0);
    return new Set(first < 0 ? [] : kinds.slice(first));
  };

  /** One row for both sections. Ownership decides what the row can do, not what it looks like: a
   * found worktree wears the same counts, since they are as real as anyone's, and its menu is the
   * short one. The dot is hollow, which is the one place the row says whose it is.
   *
   * Nothing at the dot's end of the row does anything but switch. In the strip the pointer lands on
   * the dot, the panel unfurls toward the centre under it, and a small drift while it opens used to
   * land on the kebab or on a count's verb; the counts are read now and the kebab sits in the
   * control column at the far edge, the column the plus and the caret already share. */
  const railRow = (w: WorktreeStatus) => {
    const owned = isOwned(w) ? w : null;
    const onLead = !!owned && isLead(owned.worktree);
    const counts = countsOf(w);
    const cols = drawn(counts);
    const id = w.id;
    const menuOpen = menu?.owner === "rail" && menu.key === id;
    const showCheck = owned && graftMode && canGraft(owned.worktree) && id !== activeId;
    // a landing op out from this row takes the dot's slot, and with it the row's word: the tip
    // and the line under the name say what the spinner is doing, not the state it covers
    const op = shipShown(w, shipping[id]?.op);
    return (
      <button
        key={id}
        type="button"
        className={cx("row row-edge", owned ? "rail-item" : "row-quiet rail-disc-item", menuOpen && "menu-open")}
        // an archived worktree's page marks its own row, and the row underneath does not read as picked
        data-state={rowState({ current: id === activeId && !archivedPage, checked: sel.includes(id) })}
        // one tip per row, on the row: the dot's state in words over the branch, with the dot
        // restated beside the word, since the real one is at the far end of the row from where
        // the tip sits. A tip per element would swap fifty times as the mouse crosses the panel.
        // Badges and the crashed dot keep their own, since those are what a hover over them is
        // asking about. A found row's state is that nothing of ours runs there, or who holds it,
        // and its path is its detail; an owned row's path is in its menu, where it can be copied.
        // Offline, the state is whatever the daemon last said, and a tip restating it as live sat
        // over a row painted in the fault colour, a green "Running" over an orange dot: the tip
        // names the fault instead, with no dot, since there is no live state for one to restate.
        {...(owned
          ? tip(offline ? OFFLINE_LINE : op ? shipLabel(op) : stateLabel(w, asksSetup(repoOf(owned))), undefined, {
              placement: tipSide,
              name: nameOf(w),
              aside: figuresOf(w),
              // an unseen stop says what happened under the state, so a hover is enough to triage it
              detail: w.unseen && owned.worktree.lastTurn ? recapLine(owned.worktree.lastTurn) : undefined,
              dot: offline ? undefined : op ? "spinner" : dotClass(w),
            })
          : tip(
              offline ? OFFLINE_LINE : w.locked ? `Held by ${w.lockReason ?? "another tool"}` : FOUND_LINE,
              undefined,
              {
                placement: tipSide,
                name: nameOf(w),
                detail: wtDirLabel(w),
                // the lock takes the dot's seat in the row, so the tip has no dot to restate
                dot: offline || w.locked ? undefined : "discovered",
              },
            ))}
        data-wt={id}
        // ↑↓ walk the rows while one has focus, the way the changes panel's files do: the next row
        // is picked and takes the focus, so the next press keeps walking. The ends stop the way a
        // list's do, and the found list below is its own section. ⌥↑/↓ and ⌃Tab are the walk from
        // anywhere, and that one wraps (app/keys.ts).
        onKeyDown={(e) => {
          if (!owned || graftMode || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          // a modified arrow is the global walk's, which runs after this: stepping here too moved two rows
          if (e.altKey || e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          const down = e.key === "ArrowDown";
          const at = worktrees.findIndex((w) => w.id === id);
          const next = worktrees[at + (down ? 1 : -1)];
          if (!next) return;
          dispatch({ a: "activate", id: next.id });
          e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-wt="${next.id}"]`)?.focus();
        }}
        onClick={(e) => {
          // in graft mode the row you are on is the stock the others go onto, marked by its edge,
          // and has nothing to check; every other graftable row is a source to check or uncheck.
          // A shift-click on it opens the mode with nothing checked yet.
          if (owned && (graftMode || e.shiftKey)) {
            if (id === activeId) setGraftMode(true);
            else toggleSel(owned);
          }
          // the lead is where new work is written, so a click on it puts the caret in its box; the
          // arrows above only select it, so a walk down the list keeps the keyboard on the list.
          // On a screen it is a plain selection: the draft opens on its own whenever the lead is
          // the row (withLauncher), and open-draft would reveal the chat dock, which is a layout
          // this frame cannot see and the other one would inherit.
          else if (onLead && !onScreen) dispatch({ a: "open-draft" });
          else {
            dispatch({ a: "activate", id });
            // a click lands on a row to read and reply, like the walks in app/keys.ts, and the press
            // already took the keyboard from any editor or terminal onto this button, so the
            // composer is always offered the caret. Not on touch: the screen just switched to the
            // chat, and a focused box would raise the keyboard over it.
            if (owned && !touch) dispatch({ a: "walked" });
          }
        }}
        {...cm.contextMenu(() => rowItems(w), id)}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: on touch the whole seat opens the menu the kebab in it opens, since the kebab shows on a hover that never comes; the row menu and the palette carry the same actions for the keyboard */}
        <span
          className="rail-gut"
          onClick={
            touch && !graftMode
              ? (e) => {
                  e.stopPropagation();
                  cm.openUnder(e.currentTarget, () => rowItems(w), id);
                }
              : undefined
          }
        >
          {showCheck ? (
            <input type="checkbox" className="rail-graft-check" checked={sel.includes(id)} readOnly tabIndex={-1} />
          ) : (
            !graftMode && (
              <>
                {/* at rest the column says how long since anyone sent something here, the time the
                    rail is sorted by; the kebab takes its seat while the row is lifted (rail.css).
                    The lead is never sent to, and its label already says what its click does, so
                    its column holds nothing until the kebab comes */}
                {owned && !onLead && <span className="rail-at row-dim">{ago(sentAt(owned.worktree))}</span>}
                {/* not .row-dim: it is only there while the row is lifted, and its three dots are the
                    thinnest mark in the column, so it takes the row's own colour rather than a tier
                    under it. Full size for the same reason: at the inline size the dots go hairline. */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured */}
                <span
                  className="rail-more"
                  {...tip("Actions")}
                  onClick={(e) => {
                    e.stopPropagation();
                    cm.openUnder(e.currentTarget, () => rowItems(w), id);
                  }}
                >
                  <Icon name="more" />
                </span>
              </>
            )
          )}
        </span>
        {onLead ? (
          // the row says what its click does, not which directory it is: the lead is never worked
          // in from here, so its name would be the one label on the list that is not the answer to
          // "what happens if I press this". The branch is the tip's lead.
          <span className="branch rail-main-label">
            <Icon name="plus" className="icon-inline" />
            new worktree
          </span>
        ) : (
          <span className={cx("branch", owned?.worktree.unnamed && "row-dim")}>
            {rowLabel(w, owned ? repoOf(owned) : null)}
          </span>
        )}
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
          // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured
          <span
            className="rail-badge badge-variant clickable"
            data-tip="Keep this variant, archive the others"
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
          {cols.has("dirty") && (
            <span
              className="rail-count badge-dirty"
              data-tip={counts.dirty ? `${counts.dirty} uncommitted${onLead ? " on main" : ""}` : undefined}
            >
              {counts.dirty ? `~${count(counts.dirty)}` : ""}
            </span>
          )}
          {cols.has("behind") && (
            <span
              className="rail-count rail-behind row-dim"
              data-tip={counts.behind ? `${counts.behind} behind ${onLead ? "origin" : "main"}` : undefined}
            >
              {counts.behind ? count(counts.behind) : ""}
            </span>
          )}
          {cols.has("ahead") && (
            <span
              className="rail-count badge-ahead"
              data-tip={counts.ahead ? `${counts.ahead} ahead of main` : undefined}
            >
              {counts.ahead ? `+${count(counts.ahead)}` : ""}
            </span>
          )}
        </span>
        {(() => {
          if (op) return <Spinner size="dot" />;
          // held by another tool: that is its status, so the lock takes the dot's slot rather
          // than adding a column, and the hover on the row says who holds it
          if (w.locked)
            return (
              <span className="rail-glyph rail-lock row-dim">
                <Icon name="lock" className="icon-inline" />
              </span>
            );
          // hollow: git knows about it, toyon does not run it, so there is no activity to colour
          if (!owned) return <span className="dot discovered" />;
          // a red dot means a proc died, and the only thing anyone wants next is its log. The
          // dot is the click target because in the collapsed strip it is the whole row you
          // can see; offline the colour is the socket's, not the proc's, so it stays inert.
          const trouble = graftMode || offline ? null : procTrouble(w.procs);
          // the ring is a modifier, not a state: it rides on whatever the dot already says
          const unseen = w.unseen ? " unseen" : "";
          const state = dotClass(w);
          // The lead's seat in the strip is a plus: new work starts here, and the strip has no
          // other place to say so. The dot takes the seat back whenever it has something to say
          // (its server down, the daemon gone), and it is drawn underneath either way, since the
          // peek shows the dot, with the plus in the row's own label.
          if (onLead && !trouble && state !== "crashed" && !offline) {
            return (
              <>
                <span className={`dot ${state} rail-main-dot`} />
                <span className="rail-glyph rail-main-strip">
                  <Icon name="plus" />
                </span>
              </>
            );
          }
          if (!trouble || state !== "crashed") return <span className={`dot ${state}${unseen}`} />;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: a control inside the row's button, which cannot nest one; the row menu and the palette carry the same actions for the keyboard until the row is restructured
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
        {/* last in the row so it wraps onto a line of its own (rail.css); a tier below the name,
            and the row's seat lifts it with everything else standing there */}
        {onScreen && (
          <span className="rail-say row-dim">
            {rowLine(w, {
              offline,
              needsSetup: asksSetup(owned ? repoOf(owned) : null),
              path: wtDirLabel(w),
              // the time the desk's control column carries; the lead is never sent to
              at: owned && !onLead ? ago(sentAt(owned.worktree)) : undefined,
              op,
            })}
          </span>
        )}
      </button>
    );
  };

  // On touch the strip cannot peek, since nothing hovers it, so a tap on it is the pin: the drawer
  // opens into the layout and its own pin button closes it. A tap that lands on a row or a seat is
  // theirs and does not count; the ground between and under the rows is the strip's.
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard's way to the pin is its chord, and the rows inside are buttons of their own
    <div
      ref={railRef}
      className={cx(
        "rail",
        // a screen is a drawer kept open: rail.css lists it beside hover, hold and the pin wherever
        // it draws one, so the sections and main's dot are the open drawer's here too
        onScreen && "rail-screen",
        // the peek is the strip's alone; a screen has no edge to unfurl from
        !onScreen && (graftMode || menu?.owner === "rail" || railPeek) && "hold",
        quiet && "quiet",
        // a screen is pinned as well as being a screen: the peek's panel lifts over the docks
        // beside it, and on a screen that lift would put the list over the palette and every
        // picker, which open inside the same column
        (onScreen || railOpen) && "pinned",
        offline && "offline",
      )}
      // the docks row's width for the drawer; a screen's width is the window's (rail.css), and an
      // inline value here would outrank it
      style={width !== undefined && !onScreen ? ({ "--rail-width": `${width}px` } as CSSProperties) : undefined}
      onClick={
        touch && !onScreen && !railOpen
          ? (e) => {
              if (e.target instanceof Element && e.target.closest("button, .rail-gut")) return;
              dispatch({ a: "toggle-rail" });
            }
          : undefined
      }
    >
      {/* the dots carry the socket's state, and every row's tip names it; the panel's own tip covers
          the ground between and under the rows, where the tooltip walks up to the nearest one */}
      <div className="rail-panel" data-tip={offline ? OFFLINE_LINE : undefined} data-tip-placement="follow">
        <div className="rail-list" ref={listRef}>
          {/* the lead is first on a desk, where its box is where new work is written. On a screen
              the bar's plus is that box, and the lead is not listed: a row that only says "new
              worktree" under a plus that does the same is one control twice */}
          {lead && !onScreen && railRow(lead)}
          {tasks.map(railRow)}
          {graftMode && (
            <div className="rail-graft">
              {(() => {
                // the row you are on takes the others: it keeps its agent, procs and port, and
                // the checked ones are merged into it and removed
                const target = worktrees.find((w) => w.worktree.id === activeId && canGraft(w.worktree));
                const sources = sel.filter((id) => id !== target?.worktree.id);
                const names = sources
                  .map((id) => worktrees.find((w) => w.worktree.id === id)?.worktree.title ?? id)
                  .join(", ");
                // the count alone, no icon: the stock is the row marked current, and its name or a glyph
                // on the button pushed sync, remove and cancel off the rail's width
                return (
                  <Button
                    size="md"
                    tone="primary"
                    disabled={!target || sources.length === 0}
                    data-tip={
                      target
                        ? `Merge the checked worktrees into ${target.worktree.title} and remove them`
                        : "Select a worktree to graft onto"
                    }
                    onClick={() => {
                      if (!target) return;
                      if (
                        window.confirm(
                          `Graft ${names} onto ${target.worktree.title}?\n\nTheir branches are merged in, then their directories and branches are removed.`,
                        )
                      ) {
                        sock?.send({ t: "graft", targetId: target.worktree.id, sourceIds: sources });
                        cancelGraft();
                      }
                    }}
                  >
                    graft {sources.length}
                  </Button>
                );
              })()}
              <Button
                size="md"
                disabled={!sel.some((id) => (worktrees.find((w) => w.worktree.id === id)?.behind ?? 0) > 0)}
                data-tip="Pull main into every selected worktree that's behind"
                onClick={() => {
                  // the lead is never among them: it cannot be checked (canGraft)
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
                data-tip="Archive all selected worktrees; their chats and work are kept"
                onClick={() => {
                  if (
                    window.confirm(
                      `Archive ${sel.length} worktree(s)?\n\nTheir directories and branches go. The chats, commits and any uncommitted changes are kept, and each can be restored.`,
                    )
                  ) {
                    archiveWorktrees(sock, dispatch, sel);
                    cancelGraft();
                  }
                }}
              >
                archive…
              </Button>
              <IconButton icon="close" label="Cancel" hint="esc" onClick={cancelGraft} />
            </div>
          )}
          {/* Last, below every worktree row: the whole section is hidden in the strip (see
              rail.css), so what appears when the panel opens pushes nothing anyone is aiming
              at. The rows are divs, not .rail-item buttons, so a shift-click never drags one into
              the graft selection. */}
          {!graftMode && discovered.length > 0 && (
            <>
              <button
                className="rail-disc-head"
                aria-expanded={discOpen}
                {...tip(
                  `${discovered.length} worktree${discovered.length === 1 ? "" : "s"} here that Toyon did not make`,
                  undefined,
                  { placement: tipSide },
                )}
                onClick={() => dispatch({ a: "toggle-discovered" })}
              >
                <span className="rail-gut">
                  <Icon name="caret" className={cx("icon-inline disc-caret", !discOpen && "shut")} />
                </span>
                <span className="rail-label">discovered · {discovered.length}</span>
              </button>
              {discOpen && discovered.map(railRow)}
            </>
          )}
          {/* Under discovered, for the same reason: hidden in the strip, and nothing aimed at sits below it */}
          {!graftMode && archived.length > 0 && (
            <>
              <button
                type="button"
                className="rail-disc-head"
                aria-expanded={archOpen}
                {...tip(
                  `${archived.length} archived worktree${archived.length === 1 ? "" : "s"}, kept with ${archived.length === 1 ? "its chat" : "their chats"}`,
                  undefined,
                  { placement: tipSide },
                )}
                onClick={() => dispatch({ a: "toggle-archived" })}
              >
                <span className="rail-gut">
                  <Icon name="caret" className={cx("icon-inline disc-caret", !archOpen && "shut")} />
                </span>
                <span className="rail-label">archived · {archived.length}</span>
              </button>
              {archOpen && archived.map(archivedRow)}
            </>
          )}
        </div>
        {/* the pin is the strip's: on a screen there is nothing to pin open */}
        {!onScreen && (
          <div className="rail-foot">
            <IconButton
              icon="worktrees"
              label="Worktree panel"
              hint={chord("rail")}
              tone="chrome"
              on={railOpen}
              onClick={() => dispatch({ a: "toggle-rail" })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
