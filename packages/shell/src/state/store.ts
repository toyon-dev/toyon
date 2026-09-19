// Shell state: one reducer over slices. Pure — no window/localStorage reads in here; main.tsx
// builds the initial state from the browser and passes it in (initialState), which is also why the
// reducer is testable.

import type {
  AgentCommand,
  AgentConfigInfo,
  AgentEvent,
  AgentInfo,
  ArchivedWorktree,
  AskAnswer,
  AskChoice,
  AskOutcome,
  AskQuestion,
  AttachmentRef,
  AuthMethodInfo,
  ChatHit,
  ChosenFolder,
  CommitEntry,
  ConnectFailure,
  DarkNow,
  DesignIndex,
  FileServerMsg,
  GitFileStatus,
  ImageInput,
  LogLine,
  OwnedWorktree,
  PageEntry,
  PageLink,
  PasteInput,
  PathEntry,
  PathTarget,
  PendingRepo,
  PickInput,
  PickVerb,
  RefHit,
  RemoteView,
  RepoInfo,
  SearchHit,
  SelfState,
  ServerMsg,
  SpareInfo,
  TermServerMsg,
  Theme,
  ThemePrefs,
  ToolKind,
  UpdateState,
  WorktreePages,
  WorktreeStatus,
} from "@toyon/shared";
import {
  builtinThemes,
  defaultThemePrefs,
  draftKey,
  draftRepoOf,
  isEditTool,
  isMain,
  isMarkdown,
  isOwned,
  PROJECTS_FOLDER,
  railOrder,
  resolveTheme,
  SHELL_STREAM,
  toyonDark,
} from "@toyon/shared";
import { mergeLinks } from "./links.ts";

export type UsageFigures = { used: number; size: number; cost?: number };

export type ChatItem =
  /** `seq` on the rows a chat search can land on: the transcript entry the row starts at */
  | { kind: "user"; text: string; attachments?: AttachmentRef[]; seq?: number }
  | { kind: "assistant"; text: string; seq?: number }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      output?: string;
      isError?: boolean;
      done: boolean;
      toolKind?: ToolKind;
      title?: string;
      /** the call that spawned this one, when the agent said so: the row indents under it */
      parentToolId?: string;
      /** this call is the spawn itself (a Task), so its children have somewhere to sit */
      subagent?: boolean;
    }
  | { kind: "error"; text: string }
  | { kind: "blocked"; tool: string; path: string; reason: string }
  /** a divider: what follows was said in another worktree, grafted in here */
  | { kind: "grafted"; title: string; branch: string }
  /** the daemon's word on a land that merged, kept for the record; `archiveIds` are the variant
   * siblings the landed one leaves behind, offered here where the land is read */
  | { kind: "landed"; text: string; archiveIds: string[] }
  /** the agent wants credentials; `done` once a login went through. `rejected`: it had a
   * credential and the provider refused it, so the error above this card says what went wrong */
  | {
      kind: "auth";
      agent: string;
      agentName: string;
      methods: AuthMethodInfo[];
      rejected?: boolean;
      done: boolean;
    }
  /** the agent asked something and is blocked until this is answered; `outcome` is what closed it,
   * and its absence is what "still open" means, including after a reload */
  | {
      kind: "ask";
      id: string;
      ask:
        | { kind: "question"; message: string; questions: AskQuestion[] }
        | { kind: "permission"; title: string; detail?: string; plan?: string; choices: AskChoice[] };
      outcome?: AskOutcome;
      answers?: AskAnswer[];
      choiceId?: string;
    };

export interface GitInfo {
  files: GitFileStatus[];
  committed?: GitFileStatus[];
  ahead?: number;
  behind?: number;
  /** HEAD's sha; the history tab re-reads its log when this moves */
  head?: string;
}

/** what the box holds against one ask (surfaces/chat/ask.ts): one answer per question, and the
 * question on screen */
export interface AskDraft {
  id: string;
  draft: AskAnswer[];
  current: number;
}

/** where up-arrow has walked the composer back to (surfaces/chat/recall.ts) */
export interface ComposerWalk {
  /** the sent entry's index in the chat, which is also the transcript row that is marked */
  at: number;
  /** what the box held when the walk began: nothing, or the `!` that asked for commands only */
  from: string;
}

/** The one transcript row the log marks and brings to the top: where the composer's walk back
 * through what was sent is, or a hit picked in the chats palette, found by its seq once the chat has
 * it. `n` counts the picks, so the same hit picked again is scrolled to again. Writing one replaces
 * the other. */
export type ChatMark = ({ by: "walk" } & ComposerWalk) | { by: "reveal"; seq: number; n: number };

/** the changes panel's lists: the working tree, the branch's commits, every file */
export const CHANGES_TABS = ["files", "changes", "history"] as const;
export type ChangesTab = (typeof CHANGES_TABS)[number];
const isChangesTab = (v: unknown): v is ChangesTab => CHANGES_TABS.includes(v as ChangesTab);

/** everything the shell tracks for one worktree; dropped when the worktree disappears */
export interface WorktreeLocal {
  chat: ChatItem[];
  log: LogLine[];
  git?: GitInfo;
  /** the files on disk: quick open, the @ menu and the files tab ask for it */
  files?: string[];
  /** the submodules, listed with the files: entries the tree shows but cannot open */
  submodules?: string[];
  /** the listing key (actions/file.ts) the files were last asked for; the same key asks nothing */
  filesFor?: string;
  queue: string[];
  /** a message sent from an archived page, shown as sent while the worktree comes back: gone when
   * its own message reaches the chat, and back in the box if the restore is refused */
  restoring?: string;
  /** live page state (route, title, recent errors) — ambient chat context */
  page: { url?: string; title?: string; errors: string[] };
  /** did the current agent turn edit anything / did the page HMR */
  turn: { edits: boolean; hmr: boolean };
  /** changed line ranges cache by path (post-offset numbering from the daemon) */
  changedRanges: Record<string, { ranges: Array<[number, number]>; offset: number }>;
  /** the history tab's commit list; undefined until that tab has been opened once */
  commits?: CommitEntry[];
  /** files by commit sha, filled in as commits are expanded */
  commitFiles: Record<string, GitFileStatus[]>;
  /** ⌘⇧F results */
  search: { query: string; hits: SearchHit[]; truncated: boolean } | null;
  /** the design pane's last scan; null until it has been opened once for this worktree */
  design: DesignIndex | null;
  /** the pages this worktree's files define and which changed since you last had them open, pushed
   * with its git status; undefined until the first push */
  pages?: WorktreePages;
  /** links this worktree's preview pages showed, for an app with no route table; this session only */
  links?: PageLink[];
  /** the composer's unsent text; survives switching worktrees, and is where the daemon's
   * conflict-resolution suggestion lands */
  draft: string;
  /** The row the log marks. A walk is set while up and down are walking the composer back through
   * what was sent, with `draft` holding the entry walked to, and any other write to the draft ends
   * it: a keystroke, a suggestion. A reveal lasts until a message is sent or the worktree is left. */
  mark?: ChatMark;
  /** what is attached to the message being written, in the order it was attached; `key` is local,
   * and the daemon numbers each kind on send */
  attachments: PendingAttachment[];
  /** the composer's answer to the last thing done to this box that could not be done: a command
   * with nothing to do, an attachment over the limit, a refusal from the daemon with no worktree to
   * answer on. Read under the field until the next keystroke or attachment answers it. */
  notice?: string;
  /** the answers being put together to the agent's open question, and which question the box is
   * on: kept here so switching worktrees and parking the ask keep them; gone when the ask closes */
  ask?: AskDraft;
  /** the open ask the person set aside with escape to write a message instead: the plain box is
   * back, with a line offering the ask, until it is answered or a newer one arrives */
  askParked?: string;
  /** the stop whose recap this tab arrived to, by its `lastTurn.at`. The line shows for that stop
   * until the box is written in, a turn starts, or the worktree is left; coming back is a new
   * arrival, which only a stop still unseen answers. */
  recapFor?: number;
  /** the slash commands this worktree's agent advertises; empty until it has run once */
  commands: AgentCommand[];
  /** which stream the terminal pane is showing for this worktree: its shell or one of its procs.
   * Per worktree so switching back lands on the tab you left, and in the store so the rail can
   * open a crashed proc's tab. */
  termStream: string;
  /** the model and effort the agent reported running here, from the last session-info; absent
   * until one */
  model?: string;
  /** the agent's last figures here: context in use of the window, and the session's spend when
   * the agent prices itself. Drawn as the ring by the composer; never a row in the chat. */
  usage?: UsageFigures;
  effort?: string;
}

/** The new worktree being drafted: a tab in the rail for a worktree that does not exist yet, with
 * the base it will branch from. While it is open the base is the active row, so the changes dock,
 * the terminal and ⌘1-9 keep meaning it; only the rail's mark, the centre frame and the chat dock
 * read this. Its text and attachments live in `local` under `draftKey(repoId)`. */
/** the worktree main's box is about to start: open for as long as main is the row on screen */
export interface Draft {
  /** the same prompt in N parallel worktrees, keep the best */
  variants: 1 | 2 | 3;
  /** an agent splits the prompt into a worktree per task instead */
  batch: boolean;
  /** the agent that works on it: the daemon's default when main is selected */
  agent: string;
  /** one of the repo's profiles; the repo's default when absent */
  profile?: string;
  /** main's uncommitted changes move into the worktree; honoured only for a single one (canCarry) */
  carry?: boolean;
  /** the message went; the box holds read-only until the worktree it started lands and takes the
   * selection. Cleared by a refusal, so the draft can be sent again. */
  sent?: true;
}

/** the draft moves its base's changes: asked for, and making one worktree, since one set of changes
 * cannot move into three */
export const canCarry = (d: Draft | null | undefined): boolean => !!d?.carry && !d.batch && d.variants === 1;

/** the `local` record a repo's draft is written under; never a row id, and never pruned by one */
export { draftKey };

/** the composer box the words are written in: while drafting it is the repo's draft, so it survives
 * the tab closing and reopening and is never a row's; otherwise it is the active worktree's */
export const composerBoxOf = (active: OwnedWorktree | null, drafting: boolean): string | null =>
  active ? (drafting ? draftKey(active.worktree.repoId) : active.worktree.id) : null;

/** an attachment waiting in a composer box: what the wire takes, a local key, and what its chip
 * shows before the daemon has stored it */
export type PendingAttachment =
  | (ImageInput & { key: string; bytes: number })
  | (PasteInput & { key: string; chars: number; lines: number; preview: string })
  | (PickInput & { key: string });

export const EMPTY_LOCAL: WorktreeLocal = Object.freeze({
  chat: [],
  log: [],
  queue: [],
  page: { errors: [] },
  turn: { edits: false, hmr: false },
  changedRanges: {},
  commitFiles: {},
  search: null,
  design: null,
  draft: "",
  attachments: [],
  commands: [],
  termStream: SHELL_STREAM,
}) as WorktreeLocal;

/** the modal overlays are mutually exclusive: exactly one (or none) is open */
export type Overlay =
  | { kind: "quick-open" }
  | { kind: "commands" }
  | { kind: "search" }
  /** the ref palette: a branch or PR to open as a worktree */
  | { kind: "refs" }
  /** the chats palette: what the project's chats say, live worktrees and archived ones */
  | { kind: "chats" }
  /** a project's removed worktrees: restore one, or delete it for good */
  | { kind: "archived"; repoId: string }
  | { kind: "keys" }
  /** a one-time code for a phone, as a QR */
  | { kind: "pair" }
  /** theme picker: which pref slot Enter writes */
  | { kind: "theme"; slot: "theme" | "light" | "dark" }
  | { kind: "appearance" }
  /** default-agent picker */
  | { kind: "agent" }
  /** one agent's page in settings: who it is, the files it reads, the MCP servers it loads */
  | { kind: "agent-page"; agent: string }
  /** the setup pane for a repo that is already configured (install + start commands) */
  | { kind: "setup"; repoId: string }
  | ProjectsOverlay
  /** the new-project view's location, walked to rather than typed, over the view it fills in */
  | { kind: "choose-folder" }
  /** the route bar's list of pages, opened over the address field */
  | { kind: "routes" }
  /** the lines a picked element with no recorded source may be written on, when none is clearly it */
  | { kind: "element-sources"; worktreeId: string; hits: SearchHit[] };

/** the project switcher: pick a registered repo, or type a path to open another. `pill` hangs off
 * the pill in the bar, for a click on it; `center` is the same switcher over the preview, for a key
 * or the palette, since the pill is at the far edge of the screen; `disk` is the roomier centered
 * path browser its folder button opens. */
export type ProjectsOverlay = { kind: "projects"; form: "pill" | "center" | "disk" };

/** The new-project view: a project that does not exist yet, named and placed in the
 * centre rather than in a form over it. Its second step is the first-run composer of the
 * project it makes. `creating` runs from Enter until that project's main row is listed, so nothing
 * flashes in between (a clone's import pane takes over as soon as the clone starts); `unmaking` is a
 * made project being taken back here, still listed until the daemon forgets it. */
export interface NewProjectState {
  /** `init` makes the empty folder at parent/name the project where it stands */
  mode: "create" | "clone" | "init";
  name: string;
  parent: string;
  /** clone only: what it is cloned from */
  url?: string;
  phase: "editing" | "creating" | "unmaking";
  /** the project the view is waiting on: the one it made, once listed, or the one it is taking back */
  repoId: string | null;
  /** what was typed in the first-run box before coming back here, for the next project's box */
  prompt: string;
  /** why the daemon refused the last create, read on the view until the next edit */
  error?: string;
}

/** the view with what a picker row or a way back already knew filled in */
export const newProjectState = (v: Pick<NewProjectState, "mode" | "name" | "parent" | "url">): NewProjectState => ({
  ...v,
  phase: "editing",
  repoId: null,
  prompt: "",
});

/** with no project anywhere, the view is what there is, and a first project goes in ~/Projects */
const firstProject = () => newProjectState({ mode: "create", name: "", parent: `~/${PROJECTS_FOLDER}` });

/** which side of the window the chat dock stands on; the rail stands outside it and the changes
 * dock takes the other edge. Per browser like the rail's pin (it is about this screen, not the
 * project), so it is not part of a project's Layout. */
export type ChatSide = "left" | "right";

/** which docks and panes a project is left with. One value, because it is remembered and restored
 * as a unit: per project, so a reload comes back to it and switching projects carries each one's
 * own back (zen is deliberately not in here: it is a mode you leave, not a layout). */
export interface Layout {
  changes: boolean;
  /** the changes dock's open tab, so a reload with the files tree up comes back to it */
  changesTab: ChangesTab;
  chat: boolean;
  term: boolean;
  design: boolean;
}

/** what a project that has never been laid out gets: the docks open, the panes shut */
export const defaultLayout: Layout = Object.freeze({
  changes: false,
  changesTab: "files",
  chat: true,
  term: false,
  design: false,
});

/** a stored layout is taken whole or not at all: one that does not fit costs the default */
export function isLayout(v: unknown): v is Layout {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.changes === "boolean" &&
    isChangesTab(o.changesTab) &&
    typeof o.chat === "boolean" &&
    typeof o.term === "boolean" &&
    typeof o.design === "boolean"
  );
}

/** Which screen the phone frame is on. One at a time, because the window is one column wide:
 * the list, or one of the three tabs a worktree shows under the bar.
 *
 * Deliberately not the layout, and never written by anything that touches it: the docks are the
 * desk's layout, remembered per project and carried to the next window that opens the project,
 * so a phone navigating through them would redraw a desk it cannot see.
 */
export type Screen = "home" | "chat" | "preview" | "changes";

/** Which frame this window draws: the desk's row of docks, or the phone's one screen at a time.
 * Decided in app/phone.ts from the room and the input, and kept here so the reducer can hold what
 * depends on it and no surface has to ask a question of its own. */
export type Frame = "desk" | "phone";

/** the live layout with a change, or the same state when the change is none: the layout object
 * is what the project remembers, so a new one exists only when something in it moved */
function withLayout(s: State, patch: Partial<Layout>): State {
  const l = s.layout;
  let moved = false;
  for (const k of Object.keys(patch) as (keyof Layout)[]) if (patch[k] !== l[k]) moved = true;
  return moved ? { ...s, layout: { ...l, ...patch } } : s;
}

function applyLayout(s: State, layout: Layout): State {
  // a remembered layout is a decision, so the first-diff auto-open must not second-guess it
  return { ...s, layout, changesAuto: false };
}

/** what the editor pane draws for its file: the diff against main, the file with none over it, or a
 * markdown file rendered, read-only */
export type EditorView = "diff" | "file" | "preview";

/** the view a file opens in to be read rather than compared: a markdown file rendered, anything else as text */
export const readingView = (path: string): EditorView => (isMarkdown(path) ? "preview" : "file");

/** the file as the editor last read or saved it */
export interface EditorDisk {
  before: string;
  after: string;
  /** names the bytes on disk; a save names it back as the version it replaces */
  version: string | null;
  writable: boolean;
  binary: boolean;
  tooLarge: boolean;
}

/** A jump to a line once the file shows. `fiber` is a line the running page reported, counted
 * against the served module rather than the file, which the changed-ranges offset maps back. */
export interface EditorLine {
  n: number;
  fiber?: boolean;
}

/** what a caller opens */
export interface OpenFile {
  worktreeId: string;
  path: string;
  /** a commit's copy: history, so the editor opens it read-only */
  ref?: string;
  view?: EditorView;
  line?: EditorLine;
  /** the keyboard follows the file into the editor */
  focus: boolean;
  /** names this open: a line to reveal and the keyboard are handed over once per open */
  seq: number;
}

/** a file the editor can have open: a working-tree path, or a commit's copy of one */
export type FileRef = Pick<OpenFile, "worktreeId" | "path" | "ref">;

export const sameFile = (a: FileRef, b: FileRef) =>
  a.worktreeId === b.worktreeId && a.path === b.path && a.ref === b.ref;

/** The file the editor pane has open. The pane shows it before the daemon has read it; fileSync
 * reads it and keeps what the pane shows in step with the disk. */
export interface EditorFile extends Omit<OpenFile, "view"> {
  /** null until the first read decides: a changed file opens on its diff, an unchanged one as the file */
  view: EditorView | null;
  /** null while the first read is out */
  disk: EditorDisk | null;
  /** the file changed on disk under unsaved edits: what is there now, until reload or keep mine settles it */
  conflict: { after: string; version: string | null } | null;
  /** a save refused outright, in the daemon's words: nothing typed here is saved until the file
   * is opened again, which reads it fresh */
  refused?: string;
}

/** a line the page reported, mapped back to the file once the offset for its path is known */
function placeLine(s: State, worktreeId: string, path: string, line: EditorLine): EditorLine {
  if (!line.fiber) return line;
  const offset = localOf(s, worktreeId).changedRanges[path]?.offset;
  return offset === undefined ? line : { n: line.n - offset };
}

export interface State {
  connected: boolean;
  /** why the socket is down, once the shell has worked it out; null while connected or still probing */
  connectFailure: ConnectFailure | null;
  repos: RepoInfo[];
  /** every row the daemon lists, in its order: toyon's own worktrees, then the ones git knows
   * about that toyon did not create. One array, as it arrives; the two views below split it. */
  rows: WorktreeStatus[];
  /** the project the shell is scoped to: the rail, ⌘1–9, ⌘K and settings show only its worktrees.
   * The daemon keeps every repo's procs and agents running regardless; this is a view choice. */
  activeRepoId: string | null;
  /** the rows toyon owns in the active repo, minus `archiving` (kept in step by the reducer so
   * selectors stay stable). Owned only, and in rail order (railOrder.ts): ⌘1-9 indexes this
   * positionally, the palette numbers its "switch to" rows from it, and the project pill counts
   * tasks as `length - 1`. A found row entering it would move all three silently. */
  visible: OwnedWorktree[];
  /** removes this tab has sent and the daemon has not yet confirmed. The row leaves the screen
   * on the click rather than when the daemon's next worktrees frame lands, which sits behind
   * killing the procs and the agent. `worktrees` stays the daemon's list: the snapshot that no
   * longer carries an id retires it here, an error frame brings every pending row back, and a
   * hello starts clean because a daemon that restarted mid-remove may still list it. */
  archiving: string[];
  /** the landing op (sync, merge, ship, commit) this tab has sent for a worktree and the daemon
   * has not answered. Not optimistic, unlike `archiving`: a remove's outcome is known and its
   * failure rare, while these end in ordinary results (a conflict, a hook rejecting the message,
   * nothing to commit) that are not errors to roll back from. So the row shows it working and
   * the shipped frame says what happened. That frame retires the worktree's entry, an error
   * frame (which carries no id) retires all of them, a snapshot without the worktree retires it
   * (a merge can end in a remove), and a hello starts clean. */
  shipping: Record<string, ShipOp>;
  /** the active repo's rows toyon did not create, materialised here for the same reason as
   * `visible` */
  visibleDiscovered: WorktreeStatus[];
  /** per repo: has the discovered section been opened. Collapsed is the default, so the common
   * case (a repo with nothing stray) costs nothing and never surprises anyone. */
  discoveredOpen: Record<string, boolean>;
  /** per repo: has the rail's archived section been opened; collapsed by default, like discovered */
  archivedOpen: Record<string, boolean>;
  /** per worktree: the folders opened by hand in the files tab. Remembered, unlike the folders the
   * open file reveals, which the tree keeps to itself: a few jumps with ⌘P must not leave the
   * whole tree open. Dropped with the worktree. */
  treeOpen: Record<string, string[]>;
  /** per repo: the ref palette's last reply, with the query it answered so a stale one is told
   * from the one the person is waiting on. Repo-scoped, since a ref is not a worktree's. */
  refs: Record<string, { query: string; refs: RefHit[] }>;
  /** the chats palette's last answer for each project; `query` tells a stale one from a fresh one */
  chats: Record<string, { query: string; hits: ChatHit[]; truncated: boolean }>;
  /** per repo: its archived worktrees, newest first; absent until the rail or the archive picker asks */
  archived: Record<string, ArchivedWorktree[]>;
  /** the archived worktree whose page the centre shows, by archive id. Like the draft it is a tab
   * over the active row rather than a selection: an archived worktree has no row to select, and
   * the row underneath keeps its place. Its page holds the restore button, so a click on the rail
   * shows what was kept before anything is brought back. Selecting a row closes it, and so does
   * the item leaving the list, which is what a restore or a delete does. */
  archivedPage: string | null;
  /** the worktree last selected in each repo: switching back to a project lands where you left it.
   * Persisted (App.tsx), so it survives a reload the same way the panel layout does. */
  lastActive: Record<string, string>;
  /** an "open project" was sent: the next repo the daemon adds becomes the active one */
  pendingOpen: boolean;
  activeId: string | null;
  /** this tab's id; a worktree created from here steals focus, one created elsewhere does not */
  clientId: string;
  /** worktree selected before the last reload, restored on hello */
  storedActive: string | null;
  storedRepo: string | null;
  /** the daemon has said hello, over the socket or the bootstrap fetch: what the shell shows
   * before that is nothing, not a placeholder for an empty daemon */
  heard: boolean;
  local: Record<string, WorktreeLocal>;
  /** the file the editor pane has open; null when the pane is closed */
  editor: EditorFile | null;
  /** a page the daemon's last answer opened, the PR a land made: the tab opens it once (App.tsx) */
  openUrl: string | null;
  /** bumped to request a preview reload for a worktree (the edit/HMR decision lives in this reducer) */
  reloadReq: { id: string; n: number } | null;
  /** a file is being dragged over the chat panel, which is the one place a drop attaches */
  dragFiles: boolean;
  /** the armed element picker's verb: ⌘E's chat, ⌘I's code */
  picking: PickVerb | false;
  overlay: Overlay | null;
  /** a sub-picker (theme, appearance) was opened from a palette: esc goes back there with the query restored */
  paletteReturn: { mode: "commands" | "quick-open" | "keys"; q: string } | null;
  /** the daemon speaks another protocol version than this build: stop, ask for a reload */
  incompatible: boolean;
  /** the docks and panes on screen: the active project's, and what it will be left with */
  layout: Layout;
  /** bumped to put the keyboard in the changes list; focus is the DOM's, so this only asks */
  focusChanges: number;
  /** bumped to put the suggested commit message in the changes panel's box and the caret after it */
  editCommit: number;
  /** bumped to put the keyboard in the composer, the same way */
  focusChat: number;
  /** bumped when a keyboard walk lands on a row: the composer takes the caret only if nothing
   * better (an editor, a terminal, an open ask) holds it */
  walked: number;
  /** the worktree panel is kept open, instead of peeking on hover and collapsing to the strip */
  railOpen: boolean;
  chatSide: ChatSide;
  /** bumped to put the keyboard on the rail's current row */
  focusRail: number;
  /** the collapsed rail is peeked open by the worktree walk (⌥↑/↓, ⌃Tab), the way an alt-tab
   * switcher shows while the modifier is down; app/keys.ts drops it on the release */
  railPeek: boolean;
  /** a worktree marked unread while it was the one on screen: its ring stays until another row is
   * selected, where the moment of looking would otherwise clear it again (App.tsx) */
  unreadHold: string | null;
  /** the layout each project was last left in; the active one's is `layout` itself */
  layouts: Record<string, Layout>;
  /** Where the phone frame is. The desk never reads it. Not persisted: it is where you are, not a
   * setting, and the row you were last on is remembered already. */
  screen: Screen;
  /** Which frame this window draws (app/phone.ts). The panels a project remembers are the desk's
   * layout, so `reducer` writes them only while this is the desk, whatever action moved a flag: a
   * row menu or the palette reached from the phone can flip one, and the desk must not inherit it. */
  frame: Frame;
  /** the window has no hover, so a tap is the only pointer: what the desk shows on hover has to be
   * reachable another way, on either frame */
  touch: boolean;
  /** one-shot: the changes panel starts closed and opens itself the first time the active
   * worktree has something to show, unless a remembered layout or a hand has already decided it */
  changesAuto: boolean;
  /** full-bleed preview: all chrome hidden */
  zen: boolean;
  /** bumped to put the keyboard in the terminal (the pane is `layout.term`; one shell per worktree,
   * kept running while hidden) */
  focusTerm: number;
  /** a `!` command typed on a draft, waiting for that worktree's shell to be up to type it into */
  termRun: { id: string; command: string } | null;
  /** bumped when a stream opens that needs room to be read (a login's link and its prompt) */
  termTall: number;
  /** themes the daemon knows (built-ins, ~/.toyon/themes, installed editors) + the selection */
  themes: Theme[];
  themePrefs: ThemePrefs;
  /** picker highlight, applied live while browsing */
  previewTheme: Theme | null;
  /** OS appearance (prefers-color-scheme), for themePrefs.mode === "system" */
  systemDark: boolean;
  /** the daemon's last word on the sun here, for themePrefs.mode === "daylight"; `until` 0 means a
   * carried-forward answer whose next boundary is not known yet */
  daylight: { dark: boolean; until: number } | null;
  /** the project picker's path completion: what the daemon found for `query`, and what `query`
   * itself is. `target` is what separates "no such folder" from "nothing matches yet": both arrive
   * as an empty `entries`, and only one of them is somewhere a project can be made. */
  paths: { query: string; entries: PathEntry[]; target: PathTarget | null };
  /** the daemon's home directory, for writing `~` paths the way a person would type them */
  home: string;
  /** hello's `folderDialog`: whether the view's folder buttons open Finder where the person is */
  folderDialog: boolean;
  /** hello's `remote`: the public name, and how previews are addressed when the shell was opened
   * through it */
  remote: RemoteView | null;
  /** hello's `paired`: a phone has redeemed a code on this machine, so the bar stops offering one */
  paired: boolean;
  /** codes redeemed since this page loaded, so an open pairing card can tell its code was used */
  pairings: number;
  /** hello's `gitIdentity`: git can commit without asking, so the new-project view need not */
  gitIdentity: boolean;
  /** toyon is running out of a checkout that has moved on without it: work landed there that the
   * running daemon, or the bundle it is serving this page from, does not have. Null the rest of
   * the time, which is every install that is not someone working on toyon itself. */
  self: SelfState | null;
  /** the Toyon installed on this machine is not the one running, or a restart someone asked for is
   * waiting on a chat to finish. Null the rest of the time. */
  update: UpdateState | null;
  /** the Finder dialog is up, and which of the new-project view's controls asked for it: where the
   * project goes, or a folder to open. Escape is the dialog's while it is up. */
  choosingFolder: false | "location" | "open";
  /** the new-project view, while it is up */
  newProject: NewProjectState | null;
  /** this worktree's composer should send what is already in its box, once: the description typed on
   * the new-project view, going as the first message from the box that now holds it */
  autoSend: string | null;
  /** the last answer to `choose-folder`, numbered so the form that asked can tell a new answer from
   * the one it already applied */
  chosenFolder: { seq: number; folder: ChosenFolder | null } | null;
  /** clones in flight, held by the daemon so every tab sees them and a reload does not lose them */
  pending: PendingRepo[];
  /** the import being watched in the centre, if any. Separate from `activeRepoId` because a
   * pending project has no repo record yet, and mixing the two id spaces would be a bug waiting. */
  activeImportId: string | null;
  /** the daemon's agent registry and the default for new worktrees */
  agents: AgentInfo[];
  defaultAgent: string;
  /** a person picked that default; until then the first-run screens ask which agent before the
   * first message is written to one */
  agentChosen: boolean;
  /** what settings asked the daemon about an agent's setup, by agent id */
  agentConfigs: Record<string, AgentConfigInfo>;
  /** the new worktree being drafted, if the draft tab is open */
  draft: Draft | null;
  /** every repo's warm spare, as the daemon last listed them: the preview behind a draft from
   * main, and nothing else. Can shrink between frames (a warm-up rolled back). */
  spares: SpareInfo[];
  /** each repo's remembered preview pages, best first, with their titles: the route bar's history */
  visits: Record<string, PageEntry[]>;
}

export interface InitialOpts {
  /** this tab's id; two tabs must never share one or both would steal focus */
  clientId: string;
  /** the theme painted last time, so there is no flash back to the default before hello */
  cached?: Theme;
  systemDark?: boolean;
  /** the sun as the last page load left it, so following daylight paints right away */
  daylight?: { dark: boolean; until: number } | null;
  storedActive?: string | null;
  /** project selected before the last reload, restored on hello */
  storedRepo?: string | null;
  /** the worktree panel was left open, so it starts open rather than peeking */
  storedRailOpen?: boolean;
  /** the side the chat dock was left on */
  storedChatSide?: ChatSide;
  /** every project's remembered panel layout; the stored project's is painted before hello */
  storedLayouts?: Record<string, Layout>;
  /** the worktree each project was left on, so switching projects after a reload lands where you
   * left off rather than on main */
  storedLastActive?: Record<string, string>;
  /** which projects had the discovered section open, so it does not re-collapse on every reload */
  storedDiscoveredOpen?: Record<string, boolean>;
  /** which projects had the archived section open, for the same reason */
  storedArchivedOpen?: Record<string, boolean>;
  /** the folders each worktree's files tab had open by hand */
  storedTreeOpen?: Record<string, string[]>;
  /** the frame this window opens in, so the first paint is the right one (app/phone.ts) */
  frame?: Frame;
  /** whether this window has no hover to begin with */
  touch?: boolean;
}

export function initialState(opts: InitialOpts): State {
  const cached = opts.cached ?? toyonDark;
  const state: State = {
    connected: false,
    connectFailure: null,
    repos: [],
    rows: [],
    activeRepoId: null,
    visible: [],
    archiving: [],
    shipping: {},
    visibleDiscovered: [],
    discoveredOpen: opts.storedDiscoveredOpen ?? {},
    archivedOpen: opts.storedArchivedOpen ?? {},
    treeOpen: opts.storedTreeOpen ?? {},
    refs: {},
    chats: {},
    archived: {},
    archivedPage: null,
    lastActive: opts.storedLastActive ?? {},
    pendingOpen: false,
    activeId: null,
    clientId: opts.clientId,
    storedActive: opts.storedActive ?? null,
    storedRepo: opts.storedRepo ?? null,
    heard: false,
    local: {},
    editor: null,
    openUrl: null,
    reloadReq: null,
    dragFiles: false,
    picking: false,
    overlay: null,
    paletteReturn: null,
    incompatible: false,
    layout: defaultLayout,
    focusChanges: 0,
    editCommit: 0,
    focusChat: 0,
    walked: 0,
    railOpen: opts.storedRailOpen ?? false,
    chatSide: opts.storedChatSide ?? "left",
    focusRail: 0,
    railPeek: false,
    unreadHold: null,
    layouts: opts.storedLayouts ?? {},
    // a reload on a phone comes back to the row it was reading, not to the list: the row is what
    // was remembered, so landing on home would throw away the one thing the session knew
    screen: opts.storedActive ? "chat" : "home",
    frame: opts.frame ?? "desk",
    touch: opts.touch ?? false,
    changesAuto: true,
    zen: false,
    focusTerm: 0,
    termRun: null,
    termTall: 0,
    themes: builtinThemes.some((t) => t.id === cached.id) ? builtinThemes : [...builtinThemes, cached],
    themePrefs: { ...defaultThemePrefs, mode: cached.kind, [cached.kind]: cached.id },
    previewTheme: null,
    systemDark: opts.systemDark ?? true,
    daylight: opts.daylight ?? null,
    paths: { query: "", entries: [], target: null },
    home: "",
    folderDialog: false,
    remote: null,
    paired: false,
    pairings: 0,
    // the page never shows before hello, which is what says otherwise
    gitIdentity: true,
    self: null,
    update: null,
    choosingFolder: false,
    newProject: null,
    autoSend: null,
    chosenFolder: null,
    pending: [],
    activeImportId: null,
    agents: [],
    defaultAgent: "claude",
    agentChosen: false,
    agentConfigs: {},
    draft: null,
    spares: [],
    visits: {},
  };
  // paint the last project's layout before the daemon's hello names it, so a reload does not
  // flash the docks open and then shut them
  const stored = opts.storedRepo ? state.layouts[opts.storedRepo] : undefined;
  return stored ? applyLayout(state, stored) : state;
}

/** what the following modes follow. Daylight stands in with the OS until the daemon has answered,
 * which is a better guess than a coin toss and only lasts a round trip. */
export function darkNow(s: Pick<State, "systemDark" | "daylight">): DarkNow {
  return { system: s.systemDark, daylight: s.daylight?.dark ?? s.systemDark };
}

/** the theme to paint right now: picker preview beats prefs */
export function currentTheme(s: State): Theme {
  return s.previewTheme ?? resolveTheme(s.themePrefs, s.themes, darkNow(s));
}

export function localOf(s: State, id: string | null | undefined): WorktreeLocal {
  return (id && s.local[id]) || EMPTY_LOCAL;
}

/** any row by id, owned or not */
export function rowById(s: State, id: string | null | undefined): WorktreeStatus | null {
  return (id && s.rows.find((w) => w.id === id)) || null;
}

/** a row toyon owns, by id: what the chat, the composer and landing read */
export function worktreeById(s: State, id: string | null | undefined): OwnedWorktree | null {
  const row = rowById(s, id);
  return row && isOwned(row) ? row : null;
}

/** A project with nothing in it and nothing said yet: main's tree is empty, the repo has no
 * confirmed config, and no worktree has been started from it. The composer moves to the centre for
 * exactly as long as this holds; the first message starts a worktree, and that row ends it. */
export function isGreenfield(s: State): boolean {
  const wt = worktreeById(s, s.activeId);
  // the empty-tree fact rides on main's record, so the first frame already answers this
  if (!wt || !isMain(wt.worktree) || wt.agent !== "idle" || wt.worktree.empty !== true) return false;
  const repo = repoById(s, wt.repoId);
  const started = s.rows.some((w) => w.repoId === wt.repoId && w.worktree?.kind === "worktree");
  return !!repo?.needsSetup && !started && localOf(s, wt.id).chat.length === 0;
}

/** Either first-run screen: the new-project view, or a project nobody has spoken to yet. The docks,
 * the rail and the panes hide for both, since neither has anything for them to show. */
export function isFirstRun(s: State): boolean {
  return s.newProject !== null || isGreenfield(s);
}

/** A repo with nothing to run: its settings were confirmed with no processes, or detection assumed
 * so from its build file (a Rust CLI, a Go library) and nobody has opened setup to say otherwise.
 * Nothing will ever answer on its preview, so there is no preview to show. */
export function runsNothing(repo: RepoInfo): boolean {
  return (!repo.needsSetup || !!repo.assumed) && Object.keys(repo.config.run).length === 0;
}

/** the repo's setup is still to be asked: unconfirmed, and not a guess toyon opens on without asking */
export function asksSetup(repo: RepoInfo | null | undefined): boolean {
  return !!repo?.needsSetup && !repo.assumed;
}

/** The active project runs nothing, so the chat is what the centre shows, and the chat dock and the
 * controls that work on a page go. Reads only the repos, so the app menu and the palette can ask it
 * with the state they already hold. */
export function isChatCentred(s: Pick<State, "repos" | "activeRepoId">): boolean {
  const repo = s.activeRepoId ? s.repos.find((r) => r.id === s.activeRepoId) : undefined;
  return !!repo && runsNothing(repo);
}

/** the chat is about to be written in, so its dock opens; a chat in the centre has no dock to open,
 * and writing one into the layout would leave the project's remembered panels holding it */
function revealChat(s: State): State {
  return isChatCentred(s) ? s : withLayout(s, { chat: true });
}

export function repoById(s: State, id: string | null | undefined): RepoInfo | null {
  return (id && s.repos.find((r) => r.id === id)) || null;
}

/** a repo's main row, which is what a draft branches from when nothing else is named */
export function mainOf(s: State, repoId: string | null): OwnedWorktree | null {
  return (repoId && s.rows.filter(isOwned).find((w) => w.repoId === repoId && isMain(w.worktree))) || null;
}

/** the preview on screen, if there is one: the active worktree's (main's own app while main drafts),
 * and none while the chat has the centre. The element picker and the bridge's page context follow
 * this one. */
export function previewIdOf(s: State): string | null {
  if (isChatCentred(s)) return null;
  // an archived worktree's page covers the preview: what is on screen has no page to pick from
  if (s.archivedPage) return null;
  return s.activeId;
}

/** The tab a row opens on, on a phone. Its app, when it has one and nothing is asked of you: the
 * phone is for glancing at the work, and the app is the work. Its chat when the row needs an answer
 * or finished unseen, since the answer is written there and the recap is read there; when it is
 * main, whose box is the draft; and when the project runs nothing, which has no app to open on. */
export function firstScreen(s: State, id: string): Screen {
  const row = rowById(s, id);
  if (!row || !isOwned(row) || isMain(row.worktree) || isChatCentred(s)) return "chat";
  if (row.agent === "waiting" || row.unseen || row.worktree.lastTurn?.end === "failed") return "chat";
  return "preview";
}

/** the worktree's app is running or on its way up, so its preview can be told where to go */
export function previewUp(wt: OwnedWorktree): boolean {
  return wt.procs.some((p) => p.status === "running" || p.status === "starting");
}

/** where the address bar, ⌘U and ⌘P's `/` send a path: the active worktree's preview, while it is up.
 * A fresh object each call, so a selector reads one field of it and never the whole. */
export function routeTarget(s: State): { worktreeId: string; repoId: string } | null {
  if (s.archivedPage) return null;
  const wt = worktreeById(s, s.activeId);
  return wt && previewUp(wt) ? { worktreeId: wt.worktree.id, repoId: wt.repoId } : null;
}

/** the active repo's owned rows in rail order; every repo's when nothing is selected (a daemon with
 * no repos). A row whose remove is in flight is already gone from the person's point of view.
 * Sorted here and never in `rows`: the preview frames are keyed children in `rows` order, and a
 * frame moved in the DOM reloads. */
function visibleOf(rows: WorktreeStatus[], repoId: string | null, archiving: string[]): OwnedWorktree[] {
  const owned = rows.filter(isOwned);
  const shown = archiving.length ? owned.filter((w) => !archiving.includes(w.id)) : owned;
  return railOrder(repoId ? shown.filter((w) => w.repoId === repoId) : shown);
}

/** the same narrowing for the rows toyon did not create */
function visibleDiscoveredOf(rows: WorktreeStatus[], repoId: string | null): WorktreeStatus[] {
  const found = rows.filter((r) => !isOwned(r));
  return repoId ? found.filter((d) => d.repoId === repoId) : found;
}

/** the worktree to land on in a repo: the one last selected there, else its main. Never a found
 * row, which may be gone next push, and never a row whose remove is pending: it is off screen, and
 * landing on it would select nothing. */
function landingIn(s: State, repoId: string | null, rows = s.rows): string | null {
  const owned = rows.filter(isOwned);
  const live = s.archiving.length ? owned.filter((w) => !s.archiving.includes(w.id)) : owned;
  const last = repoId ? s.lastActive[repoId] : undefined;
  if (last && live.some((w) => w.id === last)) return last;
  const mine = repoId ? live.filter((w) => w.repoId === repoId) : live;
  // looked up, not taken from the top: the daemon lists rows in the order they were made
  return (mine.find((w) => isMain(w.worktree)) ?? mine[0])?.id ?? null;
}

/** the client messages that end in a `shipped` frame: the daemon's word for them */
export type ShipOp = "sync-main" | "merge-main" | "ship" | "commit" | "pull-main" | "land";

/** `shipping` minus the entries `done` says are over, the same object when none are, so a
 * selector on it stays stable across the proc events that push most snapshots */
function retireShipping(shipping: Record<string, ShipOp>, done: (id: string) => boolean): Record<string, ShipOp> {
  const entries = Object.entries(shipping);
  const keep = entries.filter(([id]) => !done(id));
  if (keep.length === entries.length) return shipping;
  return Object.fromEntries(keep);
}

/** select a worktree, and with it its repo (a chord or a rail click never leaves you scoped to
 * a project that is not the one on screen) */
function activate(s: State, id: string | null): State {
  const row = rowById(s, id);
  // a found worktree can be selected too: it has a shell and a pane of its own, just nothing
  // toyon runs. It is deliberately not written to lastActive, which is the landing spot for a
  // project and should be somewhere that still exists next time.
  const activeRepoId = row?.repoId ?? s.activeRepoId;
  const lastActive = row && isOwned(row) ? { ...s.lastActive, [row.repoId]: row.id } : s.lastActive;
  // leaving a worktree ends the recap this tab arrived to there, and the hit a search landed on
  const leaving = s.activeId !== id ? s.activeId : null;
  const was = leaving ? s.local[leaving] : undefined;
  const settled =
    was && (was.recapFor !== undefined || was.mark?.by === "reveal") ? withoutMark(withoutRecap(was), "reveal") : null;
  const local = leaving && settled ? { ...s.local, [leaving]: settled } : s.local;
  // choosing a row is leaving an archived worktree's page: a snapshot that only re-asserts the
  // selection puts it back itself (see the worktrees frame). The draft follows main (withLauncher).
  return { ...s, activeId: id, activeRepoId, lastActive, editor: null, archivedPage: null, local };
}

/** the archived worktree whose page is up, if its project is the one on screen and it is still listed */
/** the tab the changes panel shows: the kept one, except on an archived page, which has no checkout
 * to list, so its files tab reads as changes and the kept tab is back when the page closes */
export function changesTabShown(s: Pick<State, "layout" | "archivedPage" | "activeRepoId" | "archived">): ChangesTab {
  return archivedPageOf(s) && s.layout.changesTab === "files" ? "changes" : s.layout.changesTab;
}

/** the tab `delta` steps from the one shown, wrapping; an archived page has no files tab to land on */
export function changesTabStep(
  s: Pick<State, "layout" | "archivedPage" | "activeRepoId" | "archived">,
  delta: 1 | -1,
): ChangesTab {
  const order: readonly ChangesTab[] = archivedPageOf(s) ? CHANGES_TABS.filter((t) => t !== "files") : CHANGES_TABS;
  return order[(order.indexOf(changesTabShown(s)) + delta + order.length) % order.length] ?? "changes";
}

export function archivedPageOf(s: Pick<State, "archivedPage" | "activeRepoId" | "archived">): ArchivedWorktree | null {
  if (!s.archivedPage || !s.activeRepoId) return null;
  return s.archived[s.activeRepoId]?.find((a) => a.id === s.archivedPage) ?? null;
}

function withoutRecap({ recapFor: _recapFor, ...l }: WorktreeLocal): WorktreeLocal {
  return l;
}

/** the local without its mark, when the mark is of that kind */
function withoutMark(l: WorktreeLocal, by: ChatMark["by"]): WorktreeLocal {
  if (l.mark?.by !== by) return l;
  const { mark: _mark, ...rest } = l;
  return rest;
}

export const isSubPicker = (o: Overlay) =>
  o.kind === "theme" ||
  o.kind === "appearance" ||
  o.kind === "agent" ||
  o.kind === "agent-page" ||
  o.kind === "choose-folder";

/** what reaches the reducer: terminal frames are routed to the pane, and file answers to fileSync,
 * before dispatch (main.tsx) */
export type StoreServerMsg = Exclude<ServerMsg, TermServerMsg | FileServerMsg>;

export type Action =
  | { a: "server"; msg: StoreServerMsg }
  | { a: "connected"; v: boolean; failure?: ConnectFailure | null }
  | { a: "activate"; id: string }
  /** keep the ring on a row just marked unread for as long as it stays the one on screen */
  | { a: "hold-unread"; id: string }
  /** start a new worktree: select the project's main, whose box drafts one, and put the caret there */
  | { a: "open-draft" }
  /** main's uncommitted changes go into the worktree the box starts */
  | { a: "draft-carry"; v: boolean }
  /** the draft's message was sent: the tab waits for its worktree instead of closing on main */
  | { a: "draft-sent" }
  | { a: "draft-variants"; n: Draft["variants"] }
  | { a: "draft-batch"; v: boolean }
  | { a: "draft-agent"; id: string }
  | { a: "draft-profile"; profile: string }
  /** show an archived worktree's page in the centre: what was kept, and the restore button */
  | { a: "open-archived"; id: string }
  | { a: "close-archived" }
  /** switch the shell to another registered repo */
  | { a: "activate-repo"; id: string }
  /** archive-worktree frames went out for these: hide the rows now, move the selection off them */
  | { a: "archive-worktrees"; ids: string[] }
  /** a message went from an archived page with the restore it asks for: show it as sent meanwhile */
  | { a: "restoring"; id: string; text: string }
  /** a landing op went out for this worktree: show it working until the shipped frame */
  | { a: "shipping"; id: string; op: ShipOp }
  /** an "open project" request went to the daemon: adopt the repo it adds */
  | { a: "open-repo" }
  /** open the new-project view with what is known; closes any overlay */
  | { a: "new-project"; v: NewProjectState }
  /** change what the view holds: a name typed, a folder chosen, a phase moved */
  | { a: "new-project-set"; v: Partial<NewProjectState> }
  /** leave the view for the project behind it; with no project there is nowhere to go */
  | { a: "close-new-project" }
  /** the composer took the send the view asked of it, so it is not asked twice */
  | { a: "auto-sent" }
  /** show a clone's progress in the centre (null stops watching) */
  | { a: "watch-import"; id: string | null }
  | { a: "close-editor" }
  /** the editor pane opens this file now; fileSync reads it */
  | { a: "open-file"; v: OpenFile }
  /** fileSync: what a read of the open file found, or why it could not read it */
  | { a: "editor-read"; file: FileRef; disk: EditorDisk | null; error?: string }
  /** fileSync: the file changed on disk under unsaved edits (what is there now), or that was settled */
  | { a: "editor-conflict"; file: FileRef; theirs: EditorFile["conflict"] }
  /** switch the open file between its diff and the file */
  | { a: "editor-view"; v: EditorView }
  /** fileSync: a save was refused for good, and why; the pane says so above the text */
  | { a: "editor-refused"; file: FileRef; message: string }
  /** the composer's answer to something that could not be done to this box, read until the next keystroke */
  | { a: "notice"; id: string; text: string }
  /** the answers so far to the ask on this worktree's box, and the question it is on */
  | { a: "ask-draft"; id: string; ask: AskDraft }
  /** set the open ask aside: the plain box comes back, the ask stays open for the agent */
  | { a: "ask-park"; id: string; askId: string }
  /** bring the parked ask back into the box */
  | { a: "ask-unpark"; id: string }
  /** the tab opened `openUrl` */
  | { a: "opened-url" }
  | { a: "set-draft"; id: string; text: string }
  /** someone is looking at this worktree: latch the recap of a stop they have not seen */
  | { a: "arrive"; id: string }
  /** the composer's up and down: the draft and where the walk is, in one write */
  | { a: "walk"; id: string; walk: ComposerWalk | null; text: string }
  /** a hit picked in the chats palette: mark its row, and bring it up once the chat has it */
  | { a: "reveal"; id: string; seq: number }
  /** attachments joining a composer box, after whatever is already waiting there */
  | { a: "attach"; id: string; items: PendingAttachment[] }
  | { a: "detach"; id: string; key: string }
  | { a: "clear-attachments"; id: string }
  | { a: "hmr"; id: string }
  | { a: "page"; id: string; url?: string; title?: string; error?: string; fresh?: boolean }
  /** links a preview's page showed, for an app with no route table */
  | { a: "links"; id: string; links: PageLink[] }
  | { a: "drag-files"; v: boolean }
  | { a: "set-picking"; v: PickVerb | false }
  /** open an overlay (closes any other); palettes forget a pending return, sub-pickers keep it */
  | { a: "open"; overlay: Overlay }
  /** close the open overlay; with `back`, reopen the palette a sub-picker came from */
  | { a: "close"; back?: boolean }
  | { a: "choosing-folder"; v: State["choosingFolder"] }
  | { a: "toggle"; overlay: Overlay }
  | { a: "palette-return"; v: State["paletteReturn"] }
  | { a: "toggle-changes" }
  /** open the changes panel if it is shut, and ask it for the keyboard either way; on `tab` if given */
  | { a: "focus-changes"; tab?: ChangesTab }
  | { a: "changes-tab"; v: ChangesTab }
  /** open the changes panel on its message box, the suggested commit message in it, to edit */
  | { a: "edit-commit" }
  | { a: "toggle-chat" }
  /** open the chat panel if it is shut, and ask the composer for the keyboard either way */
  | { a: "focus-chat" }
  /** a worktree walk landed on a row: offer the composer the keyboard, without opening anything */
  | { a: "walked" }
  /** the first greenfield message was sent: the chat goes back to its dock */
  | { a: "show-chat" }
  | { a: "toggle-rail" }
  /** the chat dock, and the rail with it, to the other side of the window */
  | { a: "toggle-chat-side" }
  /** pin the worktree panel if it is not, and ask its current row for the keyboard either way */
  | { a: "focus-rail" }
  /** the phone frame goes to a screen it is not on. The only action that moves `screen` on its
   * own: everywhere else it goes with something the person did to the selection, and nothing that
   * moves it may touch a panel flag. */
  | { a: "screen"; to: Screen }
  /** the window's frame changed (a desktop window dragged across the breakpoint). Back on the desk
   * the project's remembered layout is applied: the flags may have drifted while nothing drew them */
  | { a: "frame"; v: Frame }
  /** the window's input changed: hover appeared or went (a tablet's trackpad attached) */
  | { a: "touch"; v: boolean }
  /** hold the collapsed rail's peek open while the worktree walk runs, or let it fall closed */
  | { a: "rail-peek"; on: boolean }
  /** open or close the active project's discovered section */
  | { a: "toggle-discovered" }
  /** a folder in the files tab opened or closed by hand */
  | { a: "tree-folder"; worktreeId: string; path: string; open: boolean }
  /** the files were asked for under this key; the same key again asks nothing */
  | { a: "files-asked"; worktreeId: string; key: string }
  /** open or close the active project's archived section */
  | { a: "toggle-archived" }
  | { a: "toggle-zen" }
  | { a: "toggle-terminal" }
  /** open the terminal pane if it is shut, and ask the terminal for the keyboard either way */
  | { a: "focus-terminal" }
  | { a: "toggle-design" }
  /** show this worktree's stream in the terminal pane, opening the pane if it was hidden; `tall`
   * asks for room to read it */
  | { a: "term-stream"; id: string; stream: string; tall?: boolean }
  /** type a command into this worktree's shell, opening the terminal on it */
  | { a: "term-run"; id: string; command: string }
  /** the shell took the command */
  | { a: "term-ran" }
  | { a: "preview-theme"; theme: Theme | null }
  | { a: "system-dark"; v: boolean }
  | { a: "incompatible" };

function withLocal(s: State, id: string, fn: (l: WorktreeLocal) => WorktreeLocal): State {
  return { ...s, local: { ...s.local, [id]: fn(s.local[id] ?? EMPTY_LOCAL) } };
}

/** The box's answers and the parked ask belong to one ask. A new ask starts over and takes the box
 * back from a parked one; the close of the ask they belong to ends them; anything else leaves
 * them be. */
function askSettled(l: WorktreeLocal, ev: AgentEvent): WorktreeLocal {
  const asked = ev.type === "agent-question" || ev.type === "agent-permission";
  const closed = ev.type === "agent-ask-end" ? ev.id : null;
  if (!asked && !closed) return l;
  const { ask, askParked, ...rest } = l;
  return {
    ...rest,
    ...(ask && !asked && ask.id !== closed ? { ask } : {}),
    ...(askParked && !asked && askParked !== closed ? { askParked } : {}),
  };
}

/** a line of toyon's own on a worktree's chat: what the daemon answered about it, kept where the
 * work is read rather than shown for a moment somewhere else */
function noteChat(s: State, id: string, item: ChatItem): State {
  return withLocal(s, id, (l) => ({ ...l, chat: [...l.chat, item] }));
}

/** a failure answers on the worktree's chat, and opens the chat if it was shut: the answer is the
 * whole point of the press that got it */
function noteError(s: State, id: string, text: string): State {
  return noteChat(revealChat(s), id, { kind: "error", text });
}

/** a failure with no worktree to answer on (a batch, a project, a found row's sync) goes under the
 * composer on screen, the box the person is at */
function noticeOnScreen(s: State, text: string): State {
  const box = composerBoxOf(worktreeById(s, s.activeId), !!s.draft);
  return box ? withLocal(revealChat(s), box, (l) => ({ ...l, notice: text })) : s;
}

/** where a worktree's failure is read: its chat, unless it is main's, whose panel shows the draft
 * and not its log (a greenfield main aside), so main's goes under the box on screen */
function answerFor(s: State, id: string, text: string): State {
  const row = worktreeById(s, id);
  if (!row || (isMain(row.worktree) && !isGreenfield(s))) return noticeOnScreen(s, text);
  return noteError(s, id, text);
}

/** a sub-picker closed with `back`: reopen the palette it came from (its query rides along in paletteReturn) */
function paletteBack(s: State, back: boolean | undefined): Pick<State, "overlay" | "paletteReturn"> {
  const r = s.paletteReturn;
  if (!back || !r) return { overlay: null, paletteReturn: null };
  return { overlay: { kind: r.mode }, paletteReturn: r };
}

/** landing on a project paints the layout it was left in; one that has never been laid out adopts
 * whatever is on screen, so the switch itself moves nothing. The adoption is the desk's alone: on
 * the phone the flags describe no layout, and a first layout written from them would be the desk's
 * to inherit. */
function enterRepo(s: State): State {
  const id = s.activeRepoId;
  if (!id) return s;
  const remembered = s.layouts[id];
  if (remembered) return applyLayout(s, remembered);
  return s.frame === "desk" ? { ...s, layouts: { ...s.layouts, [id]: s.layout } } : s;
}

/** the first-diff auto-open is the one thing that opens a panel without anyone asking, so it is
 * the one thing the layout must not learn from: it would outlive the diff that prompted it */
function guessed(action: Action): boolean {
  return action.a === "server" && action.msg.t === "git-status";
}

/** a draft with nothing chosen yet: one worktree, the daemon's default agent */
function freshDraft(s: State): Draft {
  return { variants: 1, batch: false, agent: s.defaultAgent };
}

/** Main has no agent of its own: its box always starts a worktree, so while main is the row on
 * screen a draft is open. Not on a first-run screen, which sends its first message from the centre,
 * and not under an archived worktree's page, which is about something else. Checked after every
 * action, so a snapshot, a reload or a click that lands on main opens it the same way, and leaving
 * main for anything else drops it: what was chosen (variants, moving main's changes) is for a send
 * from this visit. */
function withLauncher(s: State): State {
  const active = worktreeById(s, s.activeId);
  const launching = !!active && isMain(active.worktree) && !s.archivedPage && !isFirstRun(s);
  if (launching) return s.draft ? s : { ...s, draft: freshDraft(s) };
  return s.draft ? { ...s, draft: null } : s;
}

/** The archived page goes, and a file of its worktree open in the editor goes with it: that file is
 * only in git, read through the page. A restore lists the id as a row again, and the file stays. */
function closeArchivedPage(s: State): State {
  const id = s.archivedPage;
  const orphaned = id !== null && s.editor?.worktreeId === id && worktreeById(s, id) === null;
  return { ...s, archivedPage: null, ...(orphaned ? { editor: null } : {}) };
}

export function reducer(s: State, action: Action): State {
  let next = withLauncher(reduce(s, action));
  // a hold is only for the row it was made on: selecting anything else, however it happened, ends it
  if (next.unreadHold !== null && next.activeId !== next.unreadHold) next = { ...next, unreadHold: null };
  // the page is for an item in the project on screen: the item restored or deleted, or the project
  // switched under it, and it is gone. Checked here, so every list refresh and repo move counts.
  // A restore lists the row before the archive list catches up, and the page ends on the row: its
  // chat carries on as the row's, under the same id.
  if (next.archivedPage !== null && (archivedPageOf(next) === null || worktreeById(next, next.archivedPage) !== null)) {
    next = closeArchivedPage(next);
  }
  // every open/close routes through here, so the layout is remembered in one place rather than in
  // the dozen actions (a chord, a rail click, a dropped file) that move it. Only on the desk: the
  // panels are its layout, and on the phone nothing draws them, so a flag flipped there (from the
  // row menu, or the palette) is not a layout anyone chose
  if (next.activeRepoId !== s.activeRepoId) next = enterRepo(next);
  else if (next.frame === "desk" && next.activeRepoId && !guessed(action) && next.layout !== s.layout) {
    next = { ...next, layouts: { ...next.layouts, [next.activeRepoId]: next.layout } };
  }
  if (next.rows === s.rows && next.activeRepoId === s.activeRepoId && next.archiving === s.archiving) {
    return next;
  }
  return {
    ...next,
    visible: visibleOf(next.rows, next.activeRepoId, next.archiving),
    visibleDiscovered: visibleDiscoveredOf(next.rows, next.activeRepoId),
  };
}

function reduce(s: State, action: Action): State {
  switch (action.a) {
    case "connected":
      // a retry's bare close keeps the last diagnosis: the probe that follows replaces it, and
      // showing "connecting" in between would flicker the pane on every backoff
      return { ...s, connected: action.v, connectFailure: action.v ? null : (action.failure ?? s.connectFailure) };
    case "activate": {
      // the phone goes with the selection: choosing a row is choosing to read it. Set here and not
      // inside activate(), which every worktrees frame runs to keep the selection valid, and which
      // would pull the phone off the list at the moment it is being read.
      const next = activate(s, action.id);
      return { ...next, screen: action.id ? firstScreen(next, action.id) : "home" };
    }
    case "open-draft": {
      // not on an empty project: a worktree off the root commit would take the scaffold to a
      // branch while main stayed blank. Nor from the new-project view, over a project not on screen.
      if (isFirstRun(s)) return s;
      const main = mainOf(s, s.activeRepoId)?.id ?? null;
      if (!main) return s;
      // the chat is where the draft is written, so it has to be on screen; a palette the chord was
      // pressed over would sit in front of it. The launcher rule in `reducer` makes the draft itself.
      return revealChat({
        ...activate(s, main),
        overlay: null,
        paletteReturn: null,
        focusChat: s.focusChat + 1,
        screen: "chat",
      });
    }
    case "draft-carry":
      return s.draft ? { ...s, draft: { ...s.draft, carry: action.v } } : s;
    case "draft-sent":
      return s.draft ? { ...s, draft: { ...s.draft, sent: true } } : s;
    case "draft-variants":
      return s.draft ? { ...s, draft: { ...s.draft, variants: action.n } } : s;
    case "draft-batch":
      return s.draft ? { ...s, draft: { ...s.draft, batch: action.v } } : s;
    case "draft-agent":
      return s.draft ? { ...s, draft: { ...s.draft, agent: action.id } } : s;
    case "draft-profile":
      return s.draft ? { ...s, draft: { ...s.draft, profile: action.profile } } : s;
    case "open-archived": {
      if (!s.activeRepoId || !s.archived[s.activeRepoId]?.some((a) => a.id === action.id)) return s;
      // a page over the row underneath: the file open there belongs to what was on screen, and is
      // not what the page is about (the draft follows main and goes by itself, see withLauncher)
      return { ...s, archivedPage: action.id, editor: null, screen: "chat" };
    }
    case "close-archived":
      return s.archivedPage ? closeArchivedPage(s) : s;
    case "restoring":
      return withLocal(s, action.id, (l) => ({ ...l, restoring: action.text }));
    case "archive-worktrees": {
      const ids = action.ids.filter((id) => !s.archiving.includes(id) && worktreeById(s, id));
      if (ids.length === 0) return s;
      const hidden = { ...s, archiving: [...s.archiving, ...ids] };
      // the selection leaves with the row, the way the daemon's own snapshot would move it
      return s.activeId && ids.includes(s.activeId) ? activate(hidden, landingIn(hidden, s.activeRepoId)) : hidden;
    }
    case "shipping": {
      // one op per worktree at a time: the daemon serializes them under the repo lock anyway,
      // and a second press before the answer is the double-click this state exists to absorb
      // any row: a found worktree can be synced, and its dot shows the op the same way
      if (s.shipping[action.id] || !rowById(s, action.id)) return s;
      return { ...s, shipping: { ...s.shipping, [action.id]: action.op } };
    }
    case "activate-repo": {
      if (!repoById(s, action.id)) return s;
      // choosing a project is leaving the new-project view for it, the project behind it included
      const left = s.newProject ? { ...s, newProject: null } : s;
      if (action.id === s.activeRepoId) return left;
      const id = landingIn(left, action.id);
      // an explicit switch beats a pending one: a clone can take minutes, and its repo arriving
      // afterwards must not yank the person out of whatever they moved to in the meantime
      return { ...activate(left, id), activeRepoId: action.id, pendingOpen: false };
    }
    case "open-repo":
      return { ...s, pendingOpen: true };
    case "new-project":
      return {
        ...s,
        newProject: action.v,
        overlay: null,
        paletteReturn: null,
        previewTheme: null,
        editor: null,
      };
    case "new-project-set": {
      if (!s.newProject) return s;
      // an edit answers the last refusal; the view moving phase on its own does not
      const edited = "name" in action.v || "parent" in action.v || "url" in action.v || "mode" in action.v;
      const { error: _error, ...page } = s.newProject;
      return { ...s, newProject: { ...(edited ? page : s.newProject), ...action.v } };
    }
    case "close-new-project":
      // with no project behind it, the view is the only thing there is to show
      return s.newProject && s.repos.length > 0 ? { ...s, newProject: null, choosingFolder: false } : s;
    case "auto-sent":
      return s.autoSend ? { ...s, autoSend: null } : s;
    case "watch-import":
      return { ...s, activeImportId: action.id };
    case "close-editor":
      return { ...s, editor: null };
    case "open-file": {
      const v = action.v;
      const e = s.editor;
      // the file already open keeps its text and view on screen while its fresh read is out
      const same = e && e.worktreeId === v.worktreeId && e.path === v.path && e.ref === v.ref ? e : null;
      const line = v.line && placeLine(s, v.worktreeId, v.path, v.line);
      return {
        ...s,
        editor: {
          worktreeId: v.worktreeId,
          path: v.path,
          ...(v.ref ? { ref: v.ref } : {}),
          view: v.view ?? same?.view ?? null,
          seq: v.seq,
          disk: same?.disk ?? null,
          ...(line ? { line } : {}),
          focus: v.focus,
          conflict: same?.conflict ?? null,
        },
      };
    }
    case "editor-read": {
      const e = s.editor;
      if (!e || !sameFile(e, action.file)) return s;
      const disk = action.disk;
      if (!disk) {
        // a pane with nothing in it yet has nothing to show, so it closes; one with text keeps it.
        // Why goes on the worktree's chat either way, since the pane may be the thing that is gone.
        const said = noteError(s, e.worktreeId, action.error ?? `could not read ${e.path}`);
        return e.disk ? said : { ...said, editor: null };
      }
      // With no view asked for, a changed file opens on its diff and an unchanged one has none to
      // show, so it opens to be read. A file with nothing on the other side (new to the branch) is
      // never shown as its diff: that would be every line added, which the changes row already says,
      // over a phantom removed line that Monaco draws for the empty side.
      const reading = readingView(e.path);
      const view =
        disk.before === ""
          ? e.view && e.view !== "diff"
            ? e.view
            : reading
          : (e.view ?? (disk.before === disk.after ? reading : "diff"));
      return { ...s, editor: { ...e, view, disk } };
    }
    case "editor-conflict": {
      const e = s.editor;
      return e && sameFile(e, action.file) ? { ...s, editor: { ...e, conflict: action.theirs } } : s;
    }
    case "editor-view":
      // the line was a one-time jump; past a switch the editor carries its own place, and a line
      // kept for the diff view would land inside a collapsed region the next time the file is read
      return s.editor ? { ...s, editor: { ...s.editor, view: action.v, line: undefined } } : s;
    case "editor-refused": {
      const e = s.editor;
      return e && sameFile(e, action.file) ? { ...s, editor: { ...e, refused: action.message } } : s;
    }
    case "notice":
      // the answer is under the box, so the box has to be on screen
      return withLocal(revealChat(s), action.id, (l) => ({ ...l, notice: action.text }));
    case "ask-draft":
      return withLocal(s, action.id, (l) => ({ ...l, ask: action.ask }));
    case "ask-park":
      return withLocal(s, action.id, (l) => ({ ...l, askParked: action.askId }));
    case "ask-unpark":
      return withLocal(s, action.id, ({ askParked: _parked, ...l }) => l);
    case "opened-url":
      return s.openUrl ? { ...s, openUrl: null } : s;
    case "set-draft":
      // writing in the box is answering the recap, and emptying the box again does not bring it
      // back. A keystroke answers the notice too; the box emptying does not, since a refused
      // command empties it on its way to saying why.
      return withLocal(s, action.id, (was) => {
        const { recapFor, notice, ...l } = withoutMark(was, "walk");
        return {
          ...l,
          draft: action.text,
          ...(recapFor !== undefined && !action.text.trim() ? { recapFor } : {}),
          ...(notice !== undefined && action.text === "" ? { notice } : {}),
        };
      });
    case "arrive": {
      const turn = rowById(s, action.id)?.worktree?.lastTurn;
      const unseen = rowById(s, action.id)?.unseen;
      // only a stop nobody has seen whose recap is due; the ring clears a moment after this
      if (!unseen || !turn?.recap) return s;
      return withLocal(s, action.id, (l) => (l.recapFor === turn.at ? l : { ...l, recapFor: turn.at }));
    }
    case "walk":
      // a walk takes the mark from a reveal, and a walk ending leaves a reveal where it is
      return withLocal(s, action.id, (l) => ({
        ...withoutMark(l, "walk"),
        draft: action.text,
        ...(action.walk ? { mark: { by: "walk" as const, at: action.walk.at, from: action.walk.from } } : {}),
      }));
    case "reveal":
      return withLocal(revealChat(s), action.id, (l) => ({
        ...l,
        mark: { by: "reveal", seq: action.seq, n: l.mark?.by === "reveal" ? l.mark.n + 1 : 1 },
      }));
    case "attach":
      // the chips are the only sign an attachment landed, so one arriving on a collapsed chat opens it
      return withLocal(revealChat(s), action.id, ({ notice: _notice, ...l }) => ({
        // attaching is writing the message, which answers the recap and the notice the way typing does
        ...withoutRecap(l),
        attachments: [...l.attachments, ...action.items],
      }));
    case "detach":
      // taking one off answers a notice about what was attached
      return withLocal(s, action.id, ({ notice: _notice, ...l }) => ({
        ...l,
        attachments: l.attachments.filter((a) => a.key !== action.key),
      }));
    case "clear-attachments":
      return withLocal(s, action.id, ({ notice: _notice, ...l }) =>
        l.attachments.length ? { ...l, attachments: [] } : l,
      );
    case "hmr":
      return withLocal(s, action.id, (l) => ({ ...l, turn: { ...l.turn, hmr: true } }));
    case "page":
      return withLocal(s, action.id, (l) => ({
        ...l,
        page: {
          url: action.url ?? l.page.url,
          title: action.title ?? l.page.title,
          errors: action.fresh ? [] : action.error ? [...l.page.errors.slice(-2), action.error] : l.page.errors,
        },
      }));
    case "links":
      return withLocal(s, action.id, (l) => {
        const links = mergeLinks(l.links ?? [], action.links);
        return links === l.links ? l : { ...l, links };
      });
    case "drag-files":
      return s.dragFiles === action.v ? s : { ...s, dragFiles: action.v };
    case "set-picking":
      return { ...s, picking: action.v };
    case "open":
      // any overlay change drops the theme picker's live preview so the kept theme paints again
      return {
        ...s,
        overlay: action.overlay,
        previewTheme: null,
        paletteReturn: isSubPicker(action.overlay) ? s.paletteReturn : null,
      };
    case "choosing-folder":
      return { ...s, choosingFolder: action.v };
    case "close":
      return { ...s, previewTheme: null, ...paletteBack(s, action.back) };
    case "toggle":
      return s.overlay?.kind === action.overlay.kind
        ? reducer(s, { a: "close" })
        : reducer(s, { a: "open", overlay: action.overlay });
    case "palette-return":
      return { ...s, paletteReturn: action.v };
    case "toggle-changes":
      return { ...withLayout(s, { changes: !s.layout.changes }), changesAuto: false };
    case "focus-changes":
      return {
        ...withLayout(s, { changes: true, changesTab: action.tab ?? s.layout.changesTab }),
        changesAuto: false,
        focusChanges: s.focusChanges + 1,
      };
    case "changes-tab":
      return withLayout(s, { changesTab: action.v });
    case "edit-commit":
      return { ...withLayout(s, { changes: true }), changesAuto: false, editCommit: s.editCommit + 1 };
    case "toggle-chat":
      // a chat in the centre has no dock to hide or show
      return isChatCentred(s) ? s : withLayout(s, { chat: !s.layout.chat });
    case "focus-chat":
      return { ...revealChat(s), focusChat: s.focusChat + 1 };
    case "walked":
      return { ...s, walked: s.walked + 1 };
    case "show-chat":
      return revealChat(s);
    case "hold-unread":
      return { ...s, unreadHold: action.id };
    case "toggle-rail":
      return { ...s, railOpen: !s.railOpen };
    case "toggle-chat-side":
      return { ...s, chatSide: s.chatSide === "left" ? "right" : "left" };
    case "focus-rail":
      // asking for the list is asking for it on either frame. railOpen is the rail's pin, which is
      // per browser and not one of the panels a project remembers, so the phone may write it.
      return { ...s, railOpen: true, focusRail: s.focusRail + 1, screen: "home" };
    case "screen":
      // the diff a file opens as lies over whichever tab it came from, so any tab, the one under
      // it included, and the way back are all a way out of it
      return s.screen === action.to && !s.editor ? s : { ...s, screen: action.to, editor: null };
    case "frame": {
      if (s.frame === action.v) return s;
      const next = { ...s, frame: action.v };
      if (action.v !== "desk" || !next.activeRepoId) return next;
      // back on the desk, the layout is the project's remembered one: while the phone drew none of
      // the docks, the row menu and the palette could still have flipped their flags
      const remembered = next.layouts[next.activeRepoId];
      return remembered ? applyLayout(next, remembered) : next;
    }
    case "touch":
      return s.touch === action.v ? s : { ...s, touch: action.v };
    case "rail-peek":
      return s.railPeek === action.on ? s : { ...s, railPeek: action.on };
    case "toggle-discovered": {
      const repoId = s.activeRepoId;
      if (!repoId) return s;
      return { ...s, discoveredOpen: { ...s.discoveredOpen, [repoId]: !s.discoveredOpen[repoId] } };
    }
    case "toggle-archived": {
      const repoId = s.activeRepoId;
      if (!repoId) return s;
      return { ...s, archivedOpen: { ...s.archivedOpen, [repoId]: !s.archivedOpen[repoId] } };
    }
    case "tree-folder": {
      const was = s.treeOpen[action.worktreeId] ?? [];
      if (was.includes(action.path) === action.open) return s;
      const now = action.open ? [...was, action.path] : was.filter((p) => p !== action.path);
      const treeOpen = { ...s.treeOpen };
      if (now.length > 0) treeOpen[action.worktreeId] = now;
      else delete treeOpen[action.worktreeId];
      return { ...s, treeOpen };
    }
    case "files-asked":
      return withLocal(s, action.worktreeId, (l) => ({ ...l, filesFor: action.key }));
    case "toggle-zen":
      // zen gives the window to the page, and a project with nothing to run has no page to give it to
      if (isChatCentred(s)) return s;
      return { ...s, zen: !s.zen };
    case "toggle-terminal":
      return withLayout(s, { term: !s.layout.term });
    case "focus-terminal":
      return { ...withLayout(s, { term: true }), focusTerm: s.focusTerm + 1 };
    case "toggle-design":
      // the pane outlines what it lists in the page; a project with nothing to run keeps it shut
      return isChatCentred(s) ? s : withLayout(s, { design: !s.layout.design });
    case "term-stream":
      return withLocal(
        { ...withLayout(s, { term: true }), termTall: action.tall ? s.termTall + 1 : s.termTall },
        action.id,
        (l) => ({ ...l, termStream: action.stream }),
      );
    case "term-run":
      // the shell's tab, with the keyboard, since what the command prints may ask for an answer
      return withLocal(
        {
          ...withLayout(s, { term: true }),
          focusTerm: s.focusTerm + 1,
          termRun: { id: action.id, command: action.command },
        },
        action.id,
        (l) => ({ ...l, termStream: SHELL_STREAM }),
      );
    case "term-ran":
      return s.termRun ? { ...s, termRun: null } : s;
    case "preview-theme":
      return { ...s, previewTheme: action.theme };
    case "system-dark":
      return { ...s, systemDark: action.v };
    case "incompatible":
      return { ...s, incompatible: true, connected: false };
    case "server":
      return onServer(s, action.msg);
  }
}

/** drop per-worktree records for rows the daemon no longer lists, found rows included: theirs
 * hold git status and history too, and a push arrives on every proc event. A spare's record (the
 * page state its preview reports) lives as long as it is listed; a repo's draft box is never a
 * row's, and any box with words in it stays, since an archived worktree keeps its draft under the
 * same id and the daemon says when one is gone for good. */
/** a record keyed by worktree id, less the ids no row has any more; the same object when none */
function pruneByRow<T>(byId: Record<string, T>, rows: WorktreeStatus[]): Record<string, T> {
  const entries = Object.entries(byId);
  const kept = entries.filter(([id]) => rows.some((w) => w.id === id));
  return kept.length === entries.length ? byId : Object.fromEntries(kept);
}

function pruneLocal(
  local: State["local"],
  rows: WorktreeStatus[],
  spares: SpareInfo[],
  archivedPage: string | null,
): State["local"] {
  const keep = new Set([...rows.map((w) => w.id), ...spares.map((sp) => sp.id)]);
  // the archived page's chat is under an id no row has, for as long as the page is up
  if (archivedPage) keep.add(archivedPage);
  const kept = ([id, l]: [string, WorktreeLocal]) => keep.has(id) || draftRepoOf(id) !== null || !!l.draft;
  const entries = Object.entries(local);
  if (entries.every(kept)) return local;
  return Object.fromEntries(entries.filter(kept));
}

/** the daemon's drafts laid into the boxes, where this tab has not written something of its own:
 * that is what it typed while the socket was down, and it goes to the daemon next */
function withDrafts(local: State["local"], drafts: Record<string, string>): State["local"] {
  let out = local;
  for (const [id, draft] of Object.entries(drafts)) {
    const l = out[id];
    if (l?.draft) continue;
    if (out === local) out = { ...local };
    out[id] = { ...(l ?? EMPTY_LOCAL), draft };
  }
  return out;
}

/** drop the per-project landing spots whose worktree is gone; the fallback is that project's main
 * either way, this just keeps dead ids out of storage */
function pruneLastActive(lastActive: Record<string, string>, rows: WorktreeStatus[]): Record<string, string> {
  const keep = new Set(rows.map((w) => w.id));
  if (Object.values(lastActive).every((id) => keep.has(id))) return lastActive;
  return Object.fromEntries(Object.entries(lastActive).filter(([, id]) => keep.has(id)));
}

/** drop remembered flags for projects the daemon no longer has, so forgetting a project does not
 * leave its key in storage forever */
function pruneByRepo<T>(flags: Record<string, T>, repos: RepoInfo[]): Record<string, T> {
  const keep = new Set(repos.map((r) => r.id));
  if (Object.keys(flags).every((id) => keep.has(id))) return flags;
  return Object.fromEntries(Object.entries(flags).filter(([id]) => keep.has(id)));
}

/** The new-project view, once the project it made has its main row: it gives way to that row's
 * first-run screen, and the description typed on the view lands in that row's box.
 *
 * It goes from there rather than from the view, so the first message of a project made here is the
 * same message as any other first message: the composer's, with its context blocks, the worktree it
 * starts with the chosen model and effort, and the chat dock coming back with the reply. With
 * nothing described, the box is left empty and waiting, which is where a project opened from the
 * terminal starts. */
function settleView(s: State): State {
  const page = s.newProject;
  if (page?.phase !== "creating" || !page.repoId) return s;
  const main = mainOf(s, page.repoId);
  if (!main) return s;
  if (!page.prompt.trim()) return { ...s, newProject: null };
  const seeded = withLocal(s, main.id, (l) => ({ ...l, draft: page.prompt }));
  return { ...seeded, newProject: null, autoSend: main.id };
}

function onServer(s: State, msg: StoreServerMsg): State {
  switch (msg.t) {
    case "hello": {
      // restore the previously selected worktree across reloads, a found one included: it is
      // still listed, and its shell and dock are what the person was looking at
      const has = (id: string | null) => !!id && msg.rows.some((w) => w.id === id);
      const hasRepo = (id: string | null) => !!id && msg.repos.some((r) => r.id === id);
      // the project narrows the fallback: a stored repo whose stored worktree is gone still opens
      // on that repo, not on whichever worktree the daemon lists first
      const repoId = hasRepo(s.activeRepoId) ? s.activeRepoId : hasRepo(s.storedRepo) ? s.storedRepo : null;
      const activeId = has(s.activeId)
        ? s.activeId
        : has(s.storedActive)
          ? s.storedActive
          : landingIn(s, repoId, msg.rows);
      const wt = msg.rows.find((w) => w.id === activeId);
      return {
        ...s,
        heard: true,
        repos: msg.repos,
        rows: msg.rows,
        activeId,
        activeRepoId: wt?.repoId ?? repoId ?? msg.repos[0]?.id ?? null,
        spares: msg.spares,
        archiving: s.archiving.length ? [] : s.archiving,
        shipping: retireShipping(s.shipping, () => true),
        local: pruneLocal(withDrafts(s.local, msg.drafts), msg.rows, msg.spares, s.archivedPage),
        lastActive: pruneLastActive(s.lastActive, msg.rows),
        treeOpen: pruneByRow(s.treeOpen, msg.rows),
        discoveredOpen: pruneByRepo(s.discoveredOpen, msg.repos),
        archivedOpen: pruneByRepo(s.archivedOpen, msg.repos),
        refs: pruneByRepo(s.refs, msg.repos),
        chats: pruneByRepo(s.chats, msg.repos),
        archived: pruneByRepo(s.archived, msg.repos),
        themes: msg.themes ?? s.themes,
        themePrefs: msg.themePrefs ?? s.themePrefs,
        agents: msg.agents,
        defaultAgent: msg.defaultAgent,
        agentChosen: msg.agentChosen,
        home: msg.home,
        folderDialog: msg.folderDialog,
        remote: msg.remote,
        paired: msg.paired,
        gitIdentity: msg.gitIdentity,
        newProject:
          s.newProject ??
          (msg.repos.length === 0 && msg.rows.length === 0 && msg.pending.length === 0 ? firstProject() : null),
        pending: msg.pending,
        visits: msg.visits,
        self: msg.self,
        update: msg.update,
        // an import this tab was watching may have finished while it was away
        activeImportId: msg.pending.some((x) => x.id === s.activeImportId) ? s.activeImportId : null,
      };
    }
    case "self":
      return { ...s, self: msg.self };
    case "paired":
      return { ...s, paired: true, pairings: s.pairings + 1 };
    case "update":
      return { ...s, update: msg.update };
    case "visits":
      return { ...s, visits: { ...s.visits, [msg.repoId]: msg.pages } };
    case "themes":
      return { ...s, themes: msg.themes, themePrefs: msg.prefs };
    case "daylight":
      return { ...s, daylight: { dark: msg.dark, until: msg.until } };
    case "agents":
      return { ...s, agents: msg.agents, defaultAgent: msg.defaultAgent, agentChosen: msg.agentChosen };
    case "agent-config": {
      const { t: _t, ...info } = msg;
      return { ...s, agentConfigs: { ...s.agentConfigs, [info.agent]: info } };
    }
    case "pending-repos": {
      const known = new Set(s.pending.map((x) => x.id));
      const started = msg.pending.find((x) => !known.has(x.id));
      // pendingOpen already means "this tab asked for a project to arrive", which is exactly who
      // should be shown the clone: the tabs that did not ask carry on with what they were doing
      const watch = started && s.pendingOpen ? started.id : s.activeImportId;
      // when the watched one finishes, stop watching: the repo it became arrives in the same
      // breath and pendingOpen is what lands on it
      const stillThere = msg.pending.some((x) => x.id === watch);
      // a failed import never becomes a repo, so the flag would otherwise sit armed and make some
      // unrelated project that arrives later steal this tab
      const failed = msg.pending.some((x) => x.id === watch && x.error);
      return {
        ...s,
        pending: msg.pending,
        activeImportId: stillThere ? watch : null,
        pendingOpen: failed ? false : s.pendingOpen,
        // a clone the view started is watched in the import pane from here, which takes the slot
        newProject: started && s.pendingOpen && s.newProject?.phase === "creating" ? null : s.newProject,
      };
    }
    case "path-entries":
      return { ...s, paths: { query: msg.query, entries: msg.entries, target: msg.target } };
    case "folder-chosen":
      return { ...s, chosenFolder: { seq: (s.chosenFolder?.seq ?? 0) + 1, folder: msg.folder } };
    case "refs":
      return { ...s, refs: { ...s.refs, [msg.repoId]: { query: msg.query, refs: msg.refs } } };
    case "chat-hits":
      return {
        ...s,
        chats: { ...s.chats, [msg.repoId]: { query: msg.query, hits: msg.hits, truncated: msg.truncated } },
      };
    case "archived":
      return { ...s, archived: { ...s.archived, [msg.repoId]: msg.items } };
    case "draft":
      // this tab wrote it and already has it, maybe with keystrokes since; a walk is showing a sent
      // message in the box, which a draft written elsewhere must not replace
      if (msg.clientId === s.clientId) return s;
      return withLocal(s, msg.boxId, (l) =>
        l.draft === msg.text || l.mark?.by === "walk" ? l : { ...l, draft: msg.text },
      );
    case "repos": {
      const known = new Set(s.repos.map((r) => r.id));
      const added = msg.repos.find((r) => !known.has(r.id));
      let activeRepoId = s.activeRepoId;
      let pendingOpen = s.pendingOpen;
      let newProject = s.newProject;
      if (added && (pendingOpen || !activeRepoId)) {
        // the project this tab asked to open (or the daemon's first repo ever): switch to it; its
        // worktrees frame follows and the landing rule below picks its main row
        activeRepoId = added.id;
        pendingOpen = false;
        // the view stays up until that main row is listed (see settleView), or the moment between
        // the two frames would show the project with nothing in it
        if (newProject && newProject.phase !== "unmaking") {
          newProject = { ...newProject, phase: "creating", repoId: added.id };
        }
      } else if (!msg.repos.some((r) => r.id === activeRepoId)) {
        activeRepoId = msg.repos[0]?.id ?? null;
      }
      // a project taken back is gone: the view is the person's again, with its name still in it
      if (newProject?.phase === "unmaking" && !msg.repos.some((r) => r.id === newProject?.repoId)) {
        newProject = { ...newProject, phase: "editing", repoId: null };
      }
      if (msg.repos.length === 0 && !newProject) newProject = firstProject();
      // a project made from nothing was committed to, so git has a name and email now, whoever typed them
      const gitIdentity = s.gitIdentity || msg.repos.some((r) => r.made && !known.has(r.id));
      if (activeRepoId === s.activeRepoId) return { ...s, repos: msg.repos, pendingOpen, newProject, gitIdentity };
      return settleView({
        ...s,
        repos: msg.repos,
        pendingOpen,
        newProject,
        gitIdentity,
        activeRepoId,
        activeId: landingIn(s, activeRepoId),
        editor: null,
      });
    }
    case "worktrees": {
      let activeId = s.activeId;
      // the selection holds as long as its row is still listed, found rows included: a push
      // arrives on every proc event and must not bounce the selection back to an owned row
      if (!activeId || !msg.rows.some((w) => w.id === activeId)) {
        activeId = landingIn(s, s.activeRepoId, msg.rows);
      }
      // auto-focus a worktree THIS tab just created (the "prompt spawns a tab" moment); one made
      // from another tab or the CLI stays where it is
      const known = new Set(s.rows.map((w) => w.id));
      const fresh = msg.rows.find(
        (w) => !known.has(w.id) && w.worktree?.kind === "worktree" && w.worktree.createdBy === s.clientId,
      );
      if (fresh && s.rows.length > 0) activeId = fresh.id;
      // a pending remove is done once the daemon stops listing the row; one it still lists is
      // still in flight (this frame is as likely another worktree's proc event as the reply)
      const archiving = s.archiving.filter((id) => msg.rows.some((w) => w.id === id));
      return settleView({
        ...activate(
          {
            ...s,
            rows: msg.rows,
            spares: msg.spares,
            archiving: archiving.length === s.archiving.length ? s.archiving : archiving,
            shipping: retireShipping(s.shipping, (id) => !msg.rows.some((w) => w.id === id)),
            local: pruneLocal(s.local, msg.rows, msg.spares, s.archivedPage),
            treeOpen: pruneByRow(s.treeOpen, msg.rows),
          },
          activeId,
        ),
        // activate closes the file because choosing a row is leaving it, but a frame that keeps the
        // selection chose nothing: status reads push one whenever a count moves, and one landing
        // between a file opening and its read closed the pane under the person who opened it
        editor: activeId === s.activeId ? s.editor : null,
        // the archived page stays up through a frame for the same reason; a worktree this tab just
        // made is the one it restored, and that row is what to look at now
        archivedPage: fresh ? null : s.archivedPage,
      });
    }
    case "proc": {
      const rows = s.rows.map((w) => (w.id === msg.worktreeId ? { ...w, procs: upsertProc(w.procs, msg.proc) } : w));
      return { ...s, rows };
    }
    case "log":
      return withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        log: [...l.log.slice(-400), { proc: msg.proc, line: msg.line }],
      }));
    case "agent": {
      const ev = msg.event;
      const id = msg.worktreeId;
      let next = withLocal(s, id, (l) => {
        const chat = applyEvent(l.chat, ev, msg.seq);
        let turn = l.turn;
        if (ev.type === "turn-start") turn = { edits: false, hmr: false };
        else if (ev.type === "tool-start" && isEditTool(ev)) turn = { ...turn, edits: true };
        // what actually ran, for the model and effort chips: the agent's word, not the record's
        const model = ev.type === "session-info" && ev.model ? ev.model : l.model;
        const effort = ev.type === "session-info" && ev.effort ? ev.effort : l.effort;
        const usage = ev.type === "usage" ? figuresOf(ev) : l.usage;
        // a message sent or a turn begun: the recap was about the stop before it
        const moved = ev.type === "turn-start" || ev.type === "user-message";
        // and a message an archived page sent is in the chat now, as the agent has it
        const { restoring: _sent, ...heard } = l;
        const base = askSettled(ev.type === "user-message" ? heard : l, ev);
        return {
          // and a message sent moves the conversation on from the hit a search landed on
          ...(moved ? withoutRecap(ev.type === "user-message" ? withoutMark(base, "reveal") : base) : base),
          chat,
          turn,
          ...(model !== l.model ? { model } : {}),
          ...(effort !== l.effort ? { effort } : {}),
          ...(usage !== l.usage ? { usage } : {}),
        };
      });
      if (ev.type === "turn-end") {
        // edits happened but nothing hot-updated: the change is outside HMR's reach
        // (backend/data) — ask the preview to reload itself
        const turn = next.local[id]!.turn;
        if (turn.edits && !turn.hmr) next = { ...next, reloadReq: { id, n: (next.reloadReq?.n ?? 0) + 1 } };
      }
      // the question goes in the box, so the box has to be on screen, the way a notice's does
      if ((ev.type === "agent-question" || ev.type === "agent-permission") && id === s.activeId)
        next = revealChat(next);
      return next;
    }
    case "backfill": {
      let chat: ChatItem[] = [];
      let usage: UsageFigures | undefined;
      for (const { seq, event } of msg.events) {
        chat = applyEvent(chat, event, seq);
        if (event.type === "usage") usage = figuresOf(event);
      }
      // a message an archived page sent stays shown until the transcript has it: a socket back
      // mid-restore hears it here rather than live
      const heard = (text: string) =>
        msg.events.some(({ event }) => event.type === "user-message" && event.text === text);
      return withLocal(s, msg.worktreeId, ({ restoring, ...l }) => ({
        ...l,
        chat,
        log: msg.log ?? l.log,
        ...(usage ? { usage } : {}),
        ...(restoring !== undefined && !heard(restoring) ? { restoring } : {}),
      }));
    }
    case "git-status": {
      // the panel is a place you go, not a fixture: it starts closed and opens itself once, the
      // first time the worktree on screen has something to show. An empty status does not spend
      // the one shot; the moment is the first diff, not the first answer.
      let changes = s.layout.changes;
      let changesAuto = s.changesAuto;
      if (s.changesAuto && msg.worktreeId === s.activeId && !changes) {
        if (msg.files.length > 0 || (msg.committed?.length ?? 0) > 0) {
          changes = true;
          changesAuto = false;
        }
      }
      // an archived worktree's page opens it when that worktree left work, or landed some: that
      // work is what the page is about
      const page = msg.worktreeId === s.archivedPage ? archivedPageOf(s) : null;
      if (page && (msg.files.length > 0 || (msg.committed?.length ?? 0) > 0 || page.landed)) changes = true;
      // ranges go stale whenever the worktree's git state moves
      const next = withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        git: { files: msg.files, committed: msg.committed, ahead: msg.ahead, behind: msg.behind, head: msg.head },
        changedRanges: {},
      }));
      return { ...withLayout(next, { changes }), changesAuto };
    }
    case "changed-ranges": {
      const next = withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        changedRanges: { ...l.changedRanges, [msg.path]: { ranges: msg.ranges, offset: msg.lineOffset } },
      }));
      // the offset this reply carries is what a jump to a line the page reported was waiting for
      const e = next.editor;
      if (!e?.line?.fiber || e.worktreeId !== msg.worktreeId || e.path !== msg.path) return next;
      return { ...next, editor: { ...e, line: placeLine(next, e.worktreeId, e.path, e.line) } };
    }
    case "shipped": {
      const id = msg.worktreeId;
      // a suggestion lands in that worktree's composer and focuses it
      const settled = msg.suggestion ? withLocal(activate(s, id), id, (l) => ({ ...l, draft: msg.suggestion! })) : s;
      const next = {
        ...settled,
        shipping: retireShipping(settled.shipping, (w) => w === id),
        openUrl: msg.ok && msg.url ? msg.url : settled.openUrl,
      };
      // What happened is read where the work is: a failure as a line on the worktree's chat, or
      // under the composer for an op with no worktree (a batch); a land that merged as a row for
      // the record. A success with nothing to offer says nothing: the panel and the row show it.
      if (!msg.ok) return id ? answerFor(next, id, msg.message) : noticeOnScreen(next, msg.message);
      if (msg.merged)
        return noteChat(next, id, { kind: "landed", text: msg.message, archiveIds: msg.archiveIds ?? [] });
      return next;
    }
    case "files":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, files: msg.paths, submodules: msg.submodules }));
    case "search-results":
      return withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        search: { query: msg.query, hits: msg.hits, truncated: msg.truncated },
      }));
    case "element-sources": {
      // a file opened since the pick was made is an answer the person already chose
      if (s.editor && s.editor.seq > msg.seq) return s;
      const [first] = msg.hits;
      if (!first) {
        // the pick came from the frame under the composer: main's frame while main drafts fills
        // the draft's box, and the answer goes under the same one
        const row = worktreeById(s, msg.worktreeId);
        const box = row ? composerBoxOf(row, !!s.draft && msg.worktreeId === s.activeId) : msg.worktreeId;
        return withLocal(s, box ?? msg.worktreeId, (l) => ({
          ...l,
          notice: "nothing in the source matches this element",
        }));
      }
      if (!msg.sure) {
        return reducer(s, {
          a: "open",
          overlay: { kind: "element-sources", worktreeId: msg.worktreeId, hits: msg.hits },
        });
      }
      // opened the way a pick with a recorded file is (openSource): the file, and the panel beside it
      const opened = reducer(s, {
        a: "open-file",
        v: {
          worktreeId: msg.worktreeId,
          path: first.path,
          view: "file",
          line: { n: first.line },
          focus: true,
          seq: msg.seq,
        },
      });
      return opened.layout.changes ? opened : reducer(opened, { a: "toggle-changes" });
    }
    case "design-index":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, design: msg.index }));
    case "routes":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, pages: { routes: msg.routes, unseen: msg.unseen } }));
    case "queue":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, queue: msg.items }));
    case "agent-commands":
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, commands: msg.commands }));
    case "git-log":
      // the expanded commit's files outlive the list they came with: the same shas are usually
      // still there after a refresh, and re-fetching them would collapse the row under the cursor
      return withLocal(s, msg.worktreeId, (l) => ({ ...l, commits: msg.commits }));
    case "git-commit":
      return withLocal(s, msg.worktreeId, (l) => ({
        ...l,
        commitFiles: { ...l.commitFiles, [msg.sha]: msg.files },
      }));
    case "error": {
      // The worktree the frame names is the one whose pending remove comes back and whose landing
      // op comes to rest; a frame that names none brings every remove back (the daemon's next
      // snapshot re-hides any that did in fact go through) and rests every op. So does the
      // new-project view: a create not yet answered by its repo is the one refused, and a project
      // it was taking back stays, so the view gives way to its first-run screen again.
      const id = msg.worktreeId;
      const page = s.newProject;
      const refused = page?.phase === "creating" && !page.repoId;
      // a sent draft is waiting on a worktree that may be what was refused: it opens for editing again
      const { sent, ...draft } = s.draft ?? {};
      const next = {
        ...s,
        archiving: id
          ? s.archiving.includes(id)
            ? s.archiving.filter((w) => w !== id)
            : s.archiving
          : s.archiving.length
            ? []
            : s.archiving,
        shipping: retireShipping(s.shipping, (w) => !id || w === id),
        newProject: refused
          ? { ...page, phase: "editing" as const, error: msg.message }
          : page?.phase === "unmaking"
            ? null
            : page,
        pendingOpen: refused ? false : s.pendingOpen,
        draft: sent ? (draft as Draft) : s.draft,
      };
      // the reason is read where the press was: a refused create on its view, a worktree's on its
      // chat, and anything else under the composer on screen
      if (refused) return next;
      // a restore asked from an archived page: the message goes back in that page's box with the
      // reason under it, rather than onto a row it never became
      const held = id ? next.local[id]?.restoring : undefined;
      if (id && held !== undefined) {
        return withLocal(next, id, ({ restoring: _held, ...l }) => ({
          ...l,
          draft: l.draft || held,
          notice: msg.message,
        }));
      }
      return id ? answerFor(next, id, msg.message) : noticeOnScreen(next, msg.message);
    }
    default: {
      // exhaustive at compile time, but a daemon one version ahead can still send a `t` this
      // build has never heard of, and returning undefined here blanks the tab on the next read
      const unknown: never = msg;
      void unknown;
      return s;
    }
  }
}

function upsertProc(procs: WorktreeStatus["procs"], p: WorktreeStatus["procs"][number]) {
  const idx = procs.findIndex((x) => x.name === p.name);
  if (idx === -1) return [...procs, p];
  const next = procs.slice();
  next[idx] = p;
  return next;
}

export /** the agent's figures as the store keeps them: cost only when it reported one */
function figuresOf(ev: Extract<AgentEvent, { type: "usage" }>): UsageFigures {
  return { used: ev.used, size: ev.size, ...(ev.cost !== undefined ? { cost: ev.cost } : {}) };
}

/** the error is that prose again, whole or behind a label of its own ("Internal error: ...") */
function repeats(message: string, prose: string): boolean {
  const said = prose.trim();
  return said !== "" && (message.trim() === said || message.trim().endsWith(`: ${said}`));
}

/** An event folded into the chat. `seq` is its transcript entry's, stamped on the rows a chat search
 * can land on as they start: a message, and prose, which keeps its first delta's seq while the rest
 * stream in. A coalesced backfill names a run by its first seq too, so a row has one name whether it
 * arrived live or on a subscribe. */
function applyEvent(items: ChatItem[], event: AgentEvent, seq?: number): ChatItem[] {
  const last = items[items.length - 1];
  const stamp = seq === undefined ? {} : { seq };
  switch (event.type) {
    case "user-message":
      return [
        ...items,
        {
          kind: "user",
          text: event.text,
          ...(event.attachments?.length ? { attachments: event.attachments } : {}),
          ...stamp,
        },
      ];
    case "text-delta":
      if (last?.kind === "assistant") return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      return [...items, { kind: "assistant", text: event.text, ...stamp }];
    case "thinking-delta":
      if (last?.kind === "thinking") return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      return [...items, { kind: "thinking", text: event.text }];
    case "tool-start":
      return [
        ...items,
        {
          kind: "tool",
          id: event.toolId,
          name: event.name,
          input: event.input,
          done: false,
          ...(event.kind ? { toolKind: event.kind } : {}),
          ...(event.title ? { title: event.title } : {}),
          ...(event.parentToolId ? { parentToolId: event.parentToolId } : {}),
          ...(event.subagent ? { subagent: true } : {}),
        },
      ];
    case "tool-update": {
      const idx = items.findLastIndex((i) => i.kind === "tool" && i.id === event.toolId);
      if (idx === -1) return items;
      const next = items.slice();
      const tool = next[idx] as Extract<ChatItem, { kind: "tool" }>;
      next[idx] = {
        ...tool,
        ...(event.name ? { name: event.name } : {}),
        ...(event.title ? { title: event.title } : {}),
        ...(event.input !== undefined ? { input: event.input } : {}),
        ...(event.kind ? { toolKind: event.kind } : {}),
      };
      return next;
    }
    case "tool-delta": {
      const idx = items.findLastIndex((i) => i.kind === "tool" && i.id === event.toolId);
      // the spawning row is the only place this text belongs, so a chunk that arrives before it (or
      // after a replay dropped it) is let go rather than opening a row of its own
      if (idx === -1) return items;
      const next = items.slice();
      const tool = next[idx] as Extract<ChatItem, { kind: "tool" }>;
      next[idx] = { ...tool, output: (tool.output ?? "") + event.text };
      return next;
    }
    case "tool-end": {
      const idx = items.findLastIndex((i) => i.kind === "tool" && i.id === event.toolId);
      if (idx === -1) return items;
      const next = items.slice();
      const tool = next[idx] as Extract<ChatItem, { kind: "tool" }>;
      next[idx] = { ...tool, output: event.output, isError: event.isError, done: true };
      return next;
    }
    case "agent-error":
      // Claude reports a usage limit as prose and then fails the turn with the same sentence; the
      // error row takes the prose's place rather than saying it twice
      if (last?.kind === "assistant" && repeats(event.message, last.text))
        return [...items.slice(0, -1), { kind: "error", text: event.message }];
      return [...items, { kind: "error", text: event.message }];
    case "agent-blocked":
      return [...items, { kind: "blocked", tool: event.tool, path: event.path, reason: event.reason }];
    case "grafted":
      return [...items, { kind: "grafted", title: event.title, branch: event.branch }];
    case "agent-auth-required":
      return [
        ...items,
        {
          kind: "auth",
          agent: event.agent,
          agentName: event.agentName,
          methods: event.methods,
          ...(event.rejected ? { rejected: true } : {}),
          done: false,
        },
      ];
    case "agent-auth-ok":
      // every message sent before the login left a card of its own, and one login answers them all
      return items.some((i) => i.kind === "auth" && !i.done)
        ? items.map((i) => (i.kind === "auth" && !i.done ? { ...i, done: true } : i))
        : items;
    case "agent-question":
      return addAsk(items, event.toolId, {
        kind: "ask",
        id: event.id,
        ask: { kind: "question", message: event.message, questions: event.questions },
      });
    case "agent-permission":
      return addAsk(items, event.toolId, {
        kind: "ask",
        id: event.id,
        ask: {
          kind: "permission",
          title: event.title,
          ...(event.detail ? { detail: event.detail } : {}),
          ...(event.plan ? { plan: event.plan } : {}),
          choices: event.choices,
        },
      });
    case "agent-ask-end": {
      const idx = items.findLastIndex((i) => i.kind === "ask" && i.id === event.id && !i.outcome);
      if (idx === -1) return items;
      const next = items.slice();
      next[idx] = {
        ...(next[idx] as Extract<ChatItem, { kind: "ask" }>),
        outcome: event.outcome,
        ...(event.answers ? { answers: event.answers } : {}),
        ...(event.choiceId ? { choiceId: event.choiceId } : {}),
      };
      return next;
    }
    default:
      return items;
  }
}

/** A card and the tool row it came from are one call, so the card takes the row's place: a
 * one-line "AskUserQuestion" above a card that already asks the question is noise. A later
 * tool-end for that id then finds nothing, which is already a no-op. */
function addAsk(items: ChatItem[], toolId: string | undefined, card: ChatItem): ChatItem[] {
  const at = toolId ? items.findLastIndex((i) => i.kind === "tool" && i.id === toolId) : -1;
  return at === -1 ? [...items, card] : [...items.slice(0, at), ...items.slice(at + 1), card];
}
