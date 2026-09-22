import {
  type ClientMsg,
  canArchive,
  canGraft,
  canLand,
  canRename,
  canSync,
  describeLand,
  isLead,
  isProvisional,
  landPolicy,
  type OwnedWorktree,
  type RepoInfo,
  type ShipOp,
  type WorktreeStatus,
} from "@toyon/shared";
import { isBusy } from "../../surfaces/util.ts";
import { grouped, type MenuEntry, type MenuItem } from "../../ui/menu.ts";
import type { DaemonSocket } from "../../ws.ts";
import { profileNames, profileOf } from "../profiles.ts";
import type { Action, State } from "../store.ts";
import { copyText, type Deps } from "./deps.ts";
import { revealItems } from "./editor.ts";

type Dispatch = (a: Action) => void;

/** the land row's second line: the repo's route, so the one verb says what it does here */
const landDetail = (repo: RepoInfo | null) =>
  describeLand(landPolicy(repo?.config ?? {}), repo?.defaultBranch).toLowerCase();

/** send a landing op (sync, land, commit, pull) and mark the worktree in flight in the same
 * breath, so no sender can send without the rail's dot and the changes panel's button showing
 * it working. The shipped frame brings it to rest; see `shipping` in the store. */
export function shipOp(sock: DaemonSocket | null, dispatch: Dispatch, msg: Extract<ClientMsg, { t: ShipOp }>) {
  dispatch({ a: "shipping", id: msg.worktreeId, op: msg.t });
  sock?.send(msg);
}

/** uncommitted files or commits ahead of main, or counts not in yet, which could be either: the
 * worktrees whose archive still asks first */
const hasWork = (w: WorktreeStatus) => w.dirty === undefined || w.ahead === undefined || w.dirty > 0 || w.ahead > 0;

/** send the archives and take the rows off screen in the same breath: the daemon confirms by
 * dropping them from its next snapshot, or an error frame puts them back, the reason on the row's chat */
export function archiveWorktrees(sock: DaemonSocket | null, dispatch: Dispatch, ids: string[]) {
  if (ids.length === 0) return;
  dispatch({ a: "archive-worktrees", ids });
  for (const id of ids) sock?.send({ t: "archive-worktree", worktreeId: id });
}

/** put the unseen ring back on a worktree to come back to. On the row you are on the store holds
 * the mark until you select another, or the moment of looking that clears rings would take it off. */
export function markUnread(sock: DaemonSocket | null, dispatch: Dispatch, id: string) {
  dispatch({ a: "hold-unread", id });
  sock?.send({ t: "mark-unread", worktreeId: id });
}

/** confirm-then-send worktree actions: the rail's badges reach these directly, the menu and the
 * palette through `worktreeItems` */
export function worktreeActions(sock: DaemonSocket | null, dispatch: Dispatch) {
  return {
    rename(w: OwnedWorktree) {
      if (!canRename(w.worktree)) return;
      const title = window.prompt("Rename worktree (its branch follows as a slug):", w.worktree.title);
      if (title?.trim()) sock?.send({ t: "rename-worktree", worktreeId: w.worktree.id, title: title.trim() });
    },
    pickVariant(w: OwnedWorktree) {
      const v = w.worktree.variant;
      if (!v) return;
      const others = v.of - 1;
      if (
        window.confirm(
          `Keep "${w.worktree.title}" and archive ${others} sibling variant(s)? Their directories and branches go; their chats and changes are kept.`,
        )
      ) {
        sock?.send({ t: "pick-variant", worktreeId: w.worktree.id });
      }
    },
    /** run under another profile: only its procs restart, so no confirm */
    setProfile(w: OwnedWorktree, profile: string) {
      sock?.send({ t: "set-worktree-profile", worktreeId: w.worktree.id, profile });
    },
    archive(w: OwnedWorktree) {
      if (!canArchive(w.worktree)) return;
      // nothing written: the rail's archived section brings the chat back, so there is nothing to ask
      if (!hasWork(w)) return archiveWorktrees(sock, dispatch, [w.worktree.id]);
      const ok = window.confirm(
        `Archive worktree "${w.worktree.title}"?\n\nIts directory and branch (${w.worktree.branch}) go. The chat, the commits and any uncommitted changes are kept, and the project menu can restore it.`,
      );
      if (ok) archiveWorktrees(sock, dispatch, [w.worktree.id]);
    },
  };
}

export type WorktreeItemState = Pick<State, "layout" | "shipping">;

/** Everything a worktree of ours can do, in the order the rail's menu shows it; the palette reads
 * the same list with the title appended. `graft` is the rail's own multi-select, so only the rail
 * passes it and the palette has no graft line. `hostname` is where the page is open: the Finder
 * row only means something on the daemon's own machine. */
export function worktreeItems(
  w: OwnedWorktree,
  repo: RepoInfo | null,
  s: WorktreeItemState,
  { sock, dispatch }: Deps,
  ui: { graft?: (id: string) => void; hostname: string },
): MenuEntry[] {
  const id = w.worktree.id;
  const acts = worktreeActions(sock, dispatch);
  // seven groups: stop, go to it, copy from it, run it, change it, land it; then remove on its own
  const stop: MenuItem[] = [];
  const go: MenuItem[] = [];
  const copy: MenuItem[] = [];
  const run: MenuItem[] = [];
  const change: MenuItem[] = [];
  const land: MenuItem[] = [];
  const gone: MenuItem[] = [];
  // stop stays offered while an ask is open: that is the way out of a question you do not want
  // to answer
  if (isBusy(w))
    stop.push({ id: "stop", label: "stop agent", onClick: () => sock?.send({ t: "stop-agent", worktreeId: id }) });
  const idle = !s.shipping[id];
  if ((w.dirty ?? 0) > 0 || (w.ahead ?? 0) > 0 || !s.layout.changes) {
    go.push({
      id: "changes",
      label: `view changes${(w.dirty ?? 0) > 0 ? ` (${w.dirty})` : ""}`,
      onClick: () => {
        dispatch({ a: "activate", id });
        if (!s.layout.changes) dispatch({ a: "toggle-changes" });
      },
    });
  }
  go.push({
    id: "terminal",
    label: "open terminal",
    // asked for, so the terminal takes the keyboard even when the pane was already open elsewhere
    onClick: () => {
      dispatch({ a: "activate", id });
      dispatch({ a: "focus-terminal" });
    },
  });
  go.push(...revealItems(() => sock?.send({ t: "reveal", worktreeId: id }), ui.hostname));
  copy.push({ id: "copy-path", label: "copy path", onClick: () => copyText(w.path) });
  copy.push({ id: "copy-branch", label: "copy branch name", onClick: () => copyText(w.worktree.branch) });
  // what a second agent is pointed at: the chat as a file it can read, and the id the agent's
  // own CLI resumes. A path rather than a link, since a link would carry the token. The lead has
  // no chat, so nothing to hand over there.
  const { transcript, sessionId } = w;
  if (transcript && !isLead(w.worktree)) {
    copy.push({ id: "copy-transcript", label: "copy transcript path", onClick: () => copyText(transcript) });
  }
  if (sessionId) copy.push({ id: "copy-session", label: "copy session id", onClick: () => copyText(sessionId) });
  // main runs procs too, and is where switching is wanted most; flat items, the menu has no
  // submenus. The one running now is on the list with its check, so the list also answers which.
  // Not on the provisional row: the worktree it starts takes its profile from the intro's chip.
  const current = profileOf(w.worktree, repo);
  for (const name of isProvisional(w.worktree) ? [] : profileNames(repo)) {
    run.push({
      id: `profile:${name}`,
      label: `run with ${name}`,
      checked: name === current,
      onClick: () => acts.setProfile(w, name),
    });
  }
  if (canRename(w.worktree)) change.push({ id: "rename", label: "rename…", onClick: () => acts.rename(w) });
  if (w.worktree.variant) change.push({ id: "keep", label: "keep this variant…", onClick: () => acts.pickVariant(w) });
  if (ui.graft && canGraft(w.worktree)) {
    const graft = ui.graft;
    change.push({ id: "graft", label: "graft with…", onClick: () => graft(id) });
  }
  // a ring to come back to; a row that already has one has nothing to add
  change.push({
    id: "unread",
    label: "mark as unread",
    disabled: w.unseen ? "already unread" : undefined,
    onClick: () => markUnread(sock, dispatch, id),
  });
  // a landing op already out for this worktree keeps the others on the list but off, with the
  // reason under them, until it answers
  const busy = idle ? undefined : "waiting on the one in progress";
  // the count on the row is read, not pressed, so the sync it used to offer lives here
  if (canSync(w) && (w.behind ?? 0) > 0) {
    land.push({
      id: "sync",
      label: `sync from main (${w.behind} behind)`,
      disabled: busy,
      onClick: () => shipOp(sock, dispatch, { t: "sync-main", worktreeId: id }),
    });
  }
  if (canLand(w.worktree)) {
    // the repo's route, whatever the settings say it is: there is one way work lands here
    land.push({
      id: "land",
      label: "land",
      detail: landDetail(repo),
      disabled: busy,
      onClick: () => shipOp(sock, dispatch, { t: "land", worktreeId: id }),
    });
  }
  // the ellipsis is the promise of a question, so an archive that asks nothing drops it
  if (canArchive(w.worktree)) {
    gone.push({
      id: "archive",
      label: hasWork(w) ? "archive…" : "archive",
      danger: true,
      onClick: () => acts.archive(w),
    });
  }
  return grouped([stop, go, copy, run, change, land, gone]);
}

/** A discovered worktree is a directory toyon does not own, so this stays short on purpose.
 * "open a shell here" is a real pty at that path with no runtime behind it, which is why it is
 * phrased as a shell rather than as this worktree's terminal: there are no proc tabs to go with
 * it, because nothing is running.
 * No "remove": the person made this directory outside toyon, and deleting it is the one thing
 * here that cannot be undone. Nothing in the daemon can delete a discovered worktree at all,
 * which is what keeps that true. `git worktree remove` is where it belongs. */
export function discoveredItems(
  d: WorktreeStatus,
  s: Pick<State, "clientId">,
  { sock, dispatch }: Deps,
  hostname: string,
): MenuEntry[] {
  const items: MenuItem[] = [];
  // held by another tool: the line stays, off, saying who has it
  const adopt: MenuItem[] = [
    {
      id: "adopt",
      label: "take over",
      disabled: d.locked ? `held by ${d.lockReason ?? "another tool"}` : undefined,
      onClick: () => sock?.send({ t: "adopt-worktree", worktreeId: d.id, clientId: s.clientId }),
    },
  ];
  // the one write without take-over: the daemon refuses unless the tree is clean
  if (canSync(d) && (d.behind ?? 0) > 0) {
    items.push({
      id: "sync",
      label: `sync from main (${d.behind} behind)`,
      onClick: () => sock?.send({ t: "sync-main", worktreeId: d.id }),
    });
  }
  items.push({
    id: "shell",
    label: "open a shell here",
    onClick: () => {
      dispatch({ a: "activate", id: d.id });
      dispatch({ a: "focus-terminal" });
    },
  });
  items.push(...revealItems(() => sock?.send({ t: "reveal", worktreeId: d.id }), hostname));
  return grouped([adopt, items, [{ id: "copy-path", label: "copy path", onClick: () => copyText(d.path) }]]);
}
