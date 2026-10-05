// Daemon ↔ shell WebSocket protocol.
//
// ServerMsg is a plain TypeScript union: the daemon is trusted and `satisfies ServerMsg` on every
// send keeps it honest. ClientMsg is a zod schema, and the type is inferred from it: client frames
// arrive from a browser (public internet in cloud mode) and are validated before any handler runs.

import { z } from "zod";
import { ATTACHMENTS_PER_MESSAGE, limitMessage, overLimit } from "../attachment.ts";
import { cachePathReason } from "../cache.ts";
import { runShared } from "../config.ts";
import type { RemoteView } from "../daemon.ts";
import { MAX_DURATION_MS, MIN_DURATION_MS, parseDuration } from "../duration.ts";
import type { ManagedView } from "../managed.ts";
import type {
  AgentConfigInfo,
  AgentInfo,
  ArchivedWorktree,
  ChatHit,
  ChosenFolder,
  CommitEntry,
  DesignIndex,
  FileBlame,
  GitFileStatus,
  InstallMethod,
  KeepAwakeMode,
  LogLine,
  PathEntry,
  PathTarget,
  PendingRepo,
  RefHit,
  RepoInfo,
  SelfState,
  Theme,
  ThemePrefs,
  ToyonConfig,
  TrunkStatus,
  UpdateCheck,
  UpdateState,
  WorktreeStatus,
} from "../model.ts";
import { KEEP_AWAKE_MODES, LOGIN_STREAM, SHELL_STREAM } from "../model.ts";
import type { PageEntry, WorktreePages } from "../routes.ts";
import type { AgentCommand, AgentEvent, AskAnswer, PasteSource, PickMeta, PickRef } from "./events.ts";
import {
  FILE_MAX_CHARS,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  IMAGE_MIME_TYPES,
  PASTE_MAX_CHARS,
  UPLOAD_MAX_BYTES,
  VARIANTS_MAX,
} from "./limits.ts";
import { elementTraitsSchema, pickMetaSchema } from "./pick.ts";

/** one content-search match: path + 1-based line + the (trimmed) line text */
export type SearchHit = { path: string; line: number; text: string };

export type ServerMsg =
  | {
      t: "hello";
      version: string;
      /** how this Toyon was installed: what the settings card says under the version, and whether
       * a press there can ask for a newer one */
      install: InstallMethod;
      /** the registry updates come from, as npm's config names it: what the settings card says
       * updates come from, so a company mirror that lags the public registry is visible. Null
       * where nothing updates: a checkout, or a machine with updates off. */
      registry: string | null;
      protocol: number;
      repos: RepoInfo[];
      /** every row: toyon's own worktrees first, in its order, then the ones git knows about that
       * toyon did not create; see the `worktrees` frame */
      rows: WorktreeStatus[];
      /** each project's default-branch checkout, by repo id: see TrunkStatus */
      trunks: Record<string, TrunkStatus>;
      themes: Theme[];
      themePrefs: ThemePrefs;
      /** the daemon's agent registry and which entry new worktrees get by default */
      agents: AgentInfo[];
      defaultAgent: string;
      /** someone has picked that default. Until then it is toyon's own choice, and the first-run
       * screens ask before the first message goes to an agent nobody named. */
      agentChosen: boolean;
      /** clones already in flight, so a tab that connects mid-import sees it straight away */
      pending: PendingRepo[];
      /** the daemon's home directory. RepoInfo.path is absolute while PathEntry.path is
       * tilde-collapsed daemon side, so without this the shell cannot write a `~` path of its own */
      home: string;
      /** the daemon can open the OS folder dialog where the person is: a macOS daemon running
       * locally. Anywhere else the dialog would open on a screen nobody at this shell can see. */
      folderDialog: boolean;
      /** when the daemon holds off the machine's idle sleep: the line in settings. Null where it
       * has no way to (not a Mac, or turned off where it was started), and settings has no line. */
      keepAwake: KeepAwakeMode | null;
      /** the public name when there is one, and how a shell served from it reaches each preview:
       * `w<id>.<name>` routed by the daemon's own listener, or `<name>:<proxy port>` */
      remote: RemoteView | null;
      /** a phone has redeemed a pairing code on this machine, at any time; until one has, the desk
       * offers the code in the bar */
      paired: boolean;
      /** git has a name and email to commit with. Making a project commits, and someone who has
       * never used git has neither, so the new-project page asks for them when this is false. */
      gitIdentity: boolean;
      /** each repo's remembered preview pages, best first, with their titles: the route bar's
       * history, there on first paint */
      visits: Record<string, PageEntry[]>;
      /** toyon is running from a checkout that has moved on without it; null the rest of the time */
      self: SelfState | null;
      /** the installed Toyon is not the one running, or a restart is waiting; null the rest of the time */
      update: UpdateState | null;
      /** the unsent text in every composer box that has some, by box id */
      drafts: Record<string, string>;
      /** what is attached and unsent in every composer box that has some, by box id */
      attachments: Record<string, AttachmentInput[]>;
      /** what whoever runs the machine has turned off, and from which file: the shell removes or
       * greys the controls and says why, while the daemon and the CLI do the refusing */
      managed: ManagedView;
    }
  | { t: "themes"; themes: Theme[]; prefs: ThemePrefs }
  /** the daemon fell behind the checkout it runs from, caught up, or started catching up */
  | { t: "self"; self: SelfState | null }
  /** a pairing code was just redeemed, so the card showing it can say so */
  | { t: "paired" }
  /** an install landed under the running daemon, or a requested restart moved on */
  | { t: "update"; update: UpdateState | null }
  /** the answer to a `check-update`, to the tab that asked */
  | { t: "update-checked"; check: UpdateCheck }
  /** the answer to a `zone`: whether the sun is down where that browser is, and when that changes.
   * Only the appearance mode that follows daylight reads it, and the shell asks again at `until`. */
  | { t: "daylight"; dark: boolean; until: number }
  | { t: "agents"; agents: AgentInfo[]; defaultAgent: string; agentChosen: boolean }
  | { t: "keep-awake"; mode: KeepAwakeMode | null }
  /** the files an agent reads and the MCP servers it will load, on request from settings */
  | ({ t: "agent-config" } & AgentConfigInfo)
  | { t: "repos"; repos: RepoInfo[] }
  /** one repo's history, whole, sent when its order or a title changes */
  | { t: "visits"; repoId: string; pages: PageEntry[] }
  /** the pages a worktree's files define and which changed since you last had them open there: sent
   * on subscribe behind git status, and again whenever either moves */
  | ({ t: "routes"; worktreeId: string } & WorktreePages)
  /** clones in flight: shown in the switcher and watched in the import pane */
  | { t: "pending-repos"; pending: PendingRepo[] }
  /** directories matching what the project picker has typed so far, plus what the typed path
   * itself is: an empty `entries` means "nothing matches here" and "there is no here" alike, and
   * only `target` separates the two */
  | { t: "path-entries"; query: string; entries: PathEntry[]; target: PathTarget }
  /** the answer to `choose-folder`: null when the dialog was cancelled or could not open */
  | { t: "folder-chosen"; folder: ChosenFolder | null }
  /** One array, owned and found rows alike: take-over turns a row owned, and were the two kinds
   * to travel in separate frames the rail would show it twice or not at all in between. A repo's
   * spare is among them, as the row new work is typed in; what its main checkout says rides
   * beside the rows in `trunks`, since main is not a row while a spare stands for it. */
  | { t: "worktrees"; rows: WorktreeStatus[]; trunks: Record<string, TrunkStatus> }
  | { t: "proc"; worktreeId: string; proc: WorktreeStatus["procs"][number] }
  /** `retract` is how many of the proc's last lines this one redraws over; a redraw wiped as the
   * process moved on is a retract with an empty line */
  | { t: "log"; worktreeId: string; proc: string; line: string; retract?: number }
  | { t: "agent"; worktreeId: string; seq: number; event: AgentEvent }
  /** on subscribe: the transcript so far and the dev servers' recent output */
  | { t: "backfill"; worktreeId: string; events: Array<{ seq: number; event: AgentEvent }>; log?: LogLine[] }
  | {
      t: "git-status";
      worktreeId: string;
      files: GitFileStatus[];
      committed?: GitFileStatus[];
      /** what the last turn that wrote anything changed: its files with their own counts, and the
       * commit holding the tree it started from, which a `read-file` names as its `since`. Absent
       * when that is the whole of `files`, or cannot be told apart from work taken in from main. */
      turn?: { base: string; files: GitFileStatus[] };
      ahead?: number;
      behind?: number;
      /** commits origin's copy of the branch lacks, counted only while a PR is open */
      unpushed?: number;
      /** HEAD's sha: the history tab re-reads its log when this moves (the agent committed) */
      head?: string;
    }
  /** the worktree's branch history, newest first (ahead-of-main commits are flagged, not sorted) */
  | { t: "git-log"; worktreeId: string; commits: CommitEntry[] }
  /** the files one commit touched; the reply to picking a commit in the history list */
  | { t: "git-commit"; worktreeId: string; sha: string; files: GitFileStatus[] }
  /** The answer to read-file, with its `seq`. `version` names the bytes on disk (null: no file
   * there), and a write names it back as its base. A binary or too-large file carries no text, and
   * neither it, a commit's copy (`ref`), nor a worktree toyon does not run is writable. A read that
   * failed is still answered, with `error`: the shell holds one request per open file until it is. */
  | {
      t: "file-read";
      worktreeId: string;
      path: string;
      ref?: string;
      since?: string;
      seq: number;
      before: string;
      after: string;
      version: string | null;
      writable: boolean;
      binary: boolean;
      tooLarge: boolean;
      error?: string;
    }
  /** The answer to write-file, exactly one per write. `changed`: the file on disk is not the base
   * the write named, and `version` is what is there now (null: nothing is). `refused`: the write
   * was not allowed at all, and `message` says why. */
  | ({ t: "file-written"; worktreeId: string; path: string; seq: number } & (
      | { ok: true; version: string }
      | { ok: false; reason: "changed" | "refused"; version: string | null; message?: string }
    ))
  /** The answer to blame-file, with its `seq`: who last touched each line of the file as it is now,
   * or as `ref` left it. Empty when git cannot say: an untracked file, or an archived worktree. */
  | ({ t: "file-blame"; worktreeId: string; path: string; ref?: string; seq: number } & FileBlame)
  /** a path opened from outside the shell (the Dock icon, `toyon <file>`) that sits in a worktree:
   * the pane opens it there */
  | { t: "open-path"; worktreeId: string; path: string }
  /** a file opened from outside every project, granted on the daemon under `id`: the pane opens
   * it loose, text in hand, and saves it through write-loose. `path` is where it lives, for the
   * open-in menu; `version` names the bytes read; `binary` is not text, opened empty and read-only
   * and drawn from `/loose/<id>` when it is a picture; `tooLarge` is more than the pane shows,
   * opened empty and read-only */
  | {
      t: "open-loose";
      id: string;
      name: string;
      path: string;
      text: string;
      binary: boolean;
      tooLarge: boolean;
      version: string | null;
    }
  /** the answer to an open-by-path the daemon could not do, read at the link that asked */
  | { t: "open-refused"; seq: number; message: string }
  /** the answer to write-loose, exactly one per write, as file-written answers a write-file */
  | ({ t: "loose-written"; id: string; seq: number } & (
      | { ok: true; version: string }
      | { ok: false; reason: "changed" | "refused"; version: string | null; message?: string }
    ))
  | {
      t: "shipped";
      worktreeId: string;
      ok: boolean;
      url?: string;
      message: string;
      /** a failure the agent was sent a turn to fix: the transcript has it as Toyon's own row, so
       * there is nothing to draw for it here */
      asked?: true;
    }
  /** the files on disk now; the submodules, which are entries but not files; and what git ignores,
   * a folder ignored whole named once with a trailing slash */
  | { t: "files"; worktreeId: string; paths: string[]; submodules: string[]; ignored: string[] }
  | { t: "search-results"; worktreeId: string; query: string; hits: SearchHit[]; truncated: boolean }
  /** where a picked element with no recorded source may be written, best first; `sure` when the first
   * is clearly it. `seq` is the find-element's, so a file opened since is not taken over. */
  | { t: "element-sources"; worktreeId: string; seq: number; hits: SearchHit[]; sure: boolean }
  /** the ref palette's rows for a query; `query` is echoed so a stale reply is told from a fresh one */
  | { t: "refs"; repoId: string; query: string; refs: RefHit[] }
  /** the chats palette's hits for a query, grouped by worktree with the newest first; `query` is
   * echoed so a stale reply is told from a fresh one */
  | { t: "chat-hits"; repoId: string; query: string; hits: ChatHit[]; truncated: boolean }
  /** a project's archived worktrees, newest first: the reply to list-archived, and pushed to every
   * tab when one is archived, restored or deleted */
  | { t: "archived"; repoId: string; items: ArchivedWorktree[] }
  /** a composer box's unsent text as a tab wrote it; `clientId` names that tab, which already has it */
  | { t: "draft"; boxId: string; text: string; clientId?: string }
  /** a composer box's unsent attachments as a tab left them; `clientId` as on `draft` */
  | { t: "attachments"; boxId: string; items: AttachmentInput[]; clientId?: string }
  | { t: "design-index"; worktreeId: string; index: DesignIndex }
  | { t: "queue"; worktreeId: string; items: QueuedMessage[] }
  /** the slash commands this worktree's agent session advertises. Ephemeral, never a transcript
   * event (it is the live session's state, not history), so it is replayed on subscribe like
   * `queue`. */
  | { t: "agent-commands"; worktreeId: string; commands: AgentCommand[] }
  | { t: "changed-ranges"; worktreeId: string; path: string; ranges: Array<[number, number]>; lineOffset: number }
  /** raw stream output; only to sockets that opened that exact tab (term-open) */
  | { t: "term-data"; worktreeId: string; stream: string; data: string }
  /** reply to term-open: the recent output to replay into a reset terminal */
  | { t: "term-snapshot"; worktreeId: string; stream: string; data: string; alive: boolean }
  | { t: "term-exit"; worktreeId: string; stream: string; exitCode: number }
  /** a client message refused, in words for the person; `worktreeId` is the one the message
   * named, so the reason lands on that worktree's chat rather than somewhere it must be looked for */
  | { t: "error"; message: string; worktreeId?: string }
  /** a message no agent took, back in the box it was sent from: the words and the chips the daemon
   * returned to it (less any whose upload is gone), and the reason, to the tab that sent it */
  | { t: "unsent"; boxId: string; text: string; items: AttachmentInput[]; message: string };

/** a message waiting its turn, as its queued row shows it and as "edit" puts it back */
export interface QueuedMessage {
  text: string;
  attachments?: AttachmentInput[];
}

/** the terminal stream: bytes for xterm, which the shell routes around its store */
export type TermServerMsg = Extract<ServerMsg, { t: "term-data" | "term-snapshot" | "term-exit" }>;
/** the editor's file answers, which the shell's file sync pairs with its requests */
export type FileServerMsg = Extract<ServerMsg, { t: "file-read" | "file-written" | "file-blame" }>;

// ---- client → daemon: schemas are the source of truth ----

const id = z.string().min(1).max(200);
const permissionModeSchema = z.enum(["auto", "ask", "plan"]);
/** a worktree-relative path; the daemon still canonicalises and bounds it (resolveInside) */
const relPath = z.string().min(1).max(4096);
/** a commit the shell is echoing back from a git-log it was sent. Hex-only, so it can never carry
 * an option or a revision expression into the `git show` that reads it. */
const sha = z.string().regex(/^[0-9a-f]{4,40}$/);
/** a request the shell pairs with its answer, which echoes it */
const seq = z.number().int().min(0);
/** a chat message */
const prose = z.string().max(200_000);
/** what rides behind a message out of the transcript, paragraph by paragraph: the page under the
 * user's eyes, what they ran, a new project's brief. The daemon adds its own and wraps them into
 * one block, so nothing here carries a wrapper of its own. */
const ambient = z.array(prose).max(8);
const prompt = z.string().max(20_000);
const shellCommand = z.string().max(2_000);
const termSize = z.number().int().min(1).max(500);
/** keystrokes, or a paste the shell chunks */
const termInput = z.string().max(65_536);
/** which of a worktree's streams: SHELL_STREAM, or a proc named in toyon.json */
const streamName = z.string().min(1).max(100);
/** a preview page as the route bar keys it: a path and maybe a hash route, never a whole URL */
const routePath = z.string().min(1).max(2_000);
/** a page's title as the document has it; the daemon collapses and caps it to what it keeps */
const pageTitle = z.string().max(1_000);

/** what an upload answered with: the name its bytes are held under until a message records them */
const uploadId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** an image as the shell sends it: already downscaled and uploaded, so the frame names it by id */
const imageInputSchema = z.object({
  kind: z.literal("image"),
  name: z.string().max(200),
  mimeType: z.enum(IMAGE_MIME_TYPES),
  upload: uploadId,
  bytes: z.number().int().min(1).max(IMAGE_MAX_BYTES),
  width: z.number().int().min(1).max(IMAGE_MAX_EDGE),
  height: z.number().int().min(1).max(IMAGE_MAX_EDGE),
});

/** the file and lines a selection copied in the editor came from */
const pasteSourceSchema = z.object({
  path: z.string().min(1).max(4096),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  ref: z.string().max(64).optional(),
});

/** a paste as the shell sends it; the daemon derives the counts rather than trusting them */
const pasteInputSchema = z.object({
  kind: z.literal("paste"),
  text: z.string().min(1).max(PASTE_MAX_CHARS),
  /** the file it came from, when it was pasted or dropped as one */
  name: z.string().max(200).optional(),
  source: pasteSourceSchema.optional(),
});

/** a file as the shell sends it: uploaded when it was attached, whatever its type */
const fileInputSchema = z.object({
  kind: z.literal("file"),
  upload: uploadId,
  name: z.string().min(1).max(200),
  bytes: z.number().int().min(1).max(UPLOAD_MAX_BYTES),
  /** the bytes read as text, as the upload found them: whether a chip can show its contents */
  text: z.boolean(),
});

/** a picked element as the shell sends it: paths already relative to the checkout it was picked in,
 * and the text and markup the bridge captured, bounded at the bridge's own caps */
const pickInputSchema = pickMetaSchema.extend({
  kind: z.literal("pick"),
  text: z.string().max(120),
  html: z.string().max(600),
});

export const attachmentInputSchema = z.discriminatedUnion("kind", [
  imageInputSchema,
  pasteInputSchema,
  fileInputSchema,
  pickInputSchema,
]);
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;
export type ImageInput = Extract<AttachmentInput, { kind: "image" }>;
export type PasteInput = Extract<AttachmentInput, { kind: "paste" }>;
export type FileInput = Extract<AttachmentInput, { kind: "file" }>;
export type PickInput = Extract<AttachmentInput, { kind: "pick" }>;

/** in the order they were attached. The length is bounded before any element is parsed; the
 * per-kind bounds are checked once every element has. */
const attachmentList = z
  .array(attachmentInputSchema)
  .max(ATTACHMENTS_PER_MESSAGE)
  .superRefine((list, ctx) => {
    const over = overLimit(list);
    if (over) ctx.addIssue({ code: "custom", message: limitMessage(over) });
  });
const attachments = attachmentList.optional();
/** the composer box a message was written in. The daemon empties it as the message arrives, and
 * fills it again when no agent took the message. */
const boxId = id.optional();

/** one question's answer on an ask card: the option values chosen, and the note typed beside them */
const askAnswerSchema = z.object({
  selected: z.array(z.string().max(2_000)).max(32),
  note: z.string().max(10_000).optional(),
});

const procName = z.string().max(100);
/** a proc is a tab in the terminal pane, so it cannot take the shell's or the login's name */
const declaredProcName = procName
  .refine((n) => n !== SHELL_STREAM, `"${SHELL_STREAM}" is reserved for the shell tab`)
  .refine((n) => n !== LOGIN_STREAM, `"${LOGIN_STREAM}" is reserved for the login tab`);
const runProfileSchema = z.object({
  run: z.array(procName).max(50),
  env: z.record(z.string().max(100), z.string().max(2_000)).optional(),
  preview: procName.optional(),
});
/** a proc: the command alone, or the long form that marks it the trunk's to run for everyone */
const runEntrySchema = z.union([
  shellCommand,
  z.object({
    cmd: shellCommand,
    from: z.literal("trunk").optional(),
    paths: z.array(z.string().max(500)).max(50).optional(),
  }),
]);
/** the proc a run's preview shows: the one named, else `web`, else the first */
function previewOf(procs: string[], preferred: string | undefined): string | undefined {
  if (preferred && procs.includes(preferred)) return preferred;
  return procs.includes("web") ? "web" : procs[0];
}

export const landConfigSchema = z.object({
  route: z.enum(["merge", "push", "pr"]).optional(),
  automerge: z.boolean().optional(),
  method: z.enum(["merge", "squash", "rebase"]).optional(),
});

/** a ceiling as the file writes it: one number and one unit, inside the bounds a guard makes sense at */
const duration = z
  .string()
  .max(20)
  .superRefine((text, ctx) => {
    const ms = parseDuration(text);
    if (ms === null)
      return ctx.addIssue({ code: "custom", message: `"${text}" is not a duration like 30m, 90s or 1h` });
    if (ms < MIN_DURATION_MS) ctx.addIssue({ code: "custom", message: `"${text}" is under 10s` });
    else if (ms > MAX_DURATION_MS) ctx.addIssue({ code: "custom", message: `"${text}" is over 24h` });
  });
export const timeoutsSchema = z.object({
  setup: duration.optional(),
  check: duration.optional(),
  commit: duration.optional(),
});

/** a path under the root a copy keeps or is keyed by */
const cachePath = z
  .string()
  .max(500)
  .superRefine((p, ctx) => {
    const why = cachePathReason(p);
    if (why) ctx.addIssue({ code: "custom", message: why });
  });
const cachePaths = z.array(cachePath).min(1).max(50);
export const cacheConfigSchema = z.object({
  paths: cachePaths,
  key: z.array(cachePath).max(50).optional(),
  tools: z.array(shellCommand).max(20).optional(),
});

export const toyonConfigSchema = z
  .object({
    $schema: z.string().max(2_000).optional(),
    setup: z.array(shellCommand).max(50).optional(),
    teardown: z.array(shellCommand).max(50).optional(),
    run: z.record(declaredProcName, runEntrySchema),
    check: shellCommand.optional(),
    afterLand: z.array(shellCommand).max(50).optional(),
    land: landConfigSchema.optional(),
    timeouts: timeoutsSchema.optional(),
    cache: z.union([cachePaths, cacheConfigSchema]).optional(),
    preview: procName.optional(),
    profiles: z.record(procName, runProfileSchema).optional(),
    defaultProfile: procName.optional(),
  })
  .superRefine((c, ctx) => {
    // auto-merge is GitHub's; on a local route it would promise something nothing does
    if (c.land?.automerge !== undefined && c.land.route !== "pr")
      ctx.addIssue({ code: "custom", path: ["land", "automerge"], message: 'automerge needs "route": "pr"' });
    // the preview is the one proc every worktree runs itself: a page served from main would show
    // main's code in a worktree's frame
    const shared = (name: string | undefined) => name !== undefined && runShared(c.run[name] ?? "");
    const top = previewOf(Object.keys(c.run), c.preview);
    if (shared(top)) {
      ctx.addIssue({ code: "custom", path: ["run", top!], message: `the preview "${top}" cannot be from the trunk` });
    }
    for (const [name, p] of Object.entries(c.profiles ?? {})) {
      const preview = previewOf(p.run, p.preview ?? c.preview);
      if (shared(preview) && preview !== top) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", name, "preview"],
          message: `the preview "${preview}" cannot be from the trunk`,
        });
      }
    }
    // a profile may only name processes that exist, and the default must be a profile: caught here
    // so a typo is a refusal at confirm/reload time, not a worktree that silently runs nothing
    if (!c.profiles) {
      if (c.defaultProfile !== undefined)
        ctx.addIssue({ code: "custom", path: ["defaultProfile"], message: "defaultProfile without profiles" });
      return;
    }
    for (const [name, p] of Object.entries(c.profiles)) {
      for (const proc of p.run) {
        if (!(proc in c.run))
          ctx.addIssue({ code: "custom", path: ["profiles", name, "run"], message: `"${proc}" is not in run` });
      }
      if (p.preview !== undefined && !p.run.includes(p.preview))
        ctx.addIssue({ code: "custom", path: ["profiles", name, "preview"], message: "preview is not in run" });
    }
    if (c.defaultProfile === undefined)
      ctx.addIssue({ code: "custom", path: ["defaultProfile"], message: "required when profiles are set" });
    else if (!(c.defaultProfile in c.profiles))
      ctx.addIssue({ code: "custom", path: ["defaultProfile"], message: `unknown profile "${c.defaultProfile}"` });
  });

export const themePrefsSchema = z.object({
  mode: z.enum(["dark", "light", "system", "daylight"]),
  light: z.string(),
  dark: z.string(),
});

export const clientMsgSchema = z.discriminatedUnion("t", [
  /** receive this worktree's stream (agent events, logs, queue, git status); replies with a backfill */
  z.object({ t: z.literal("subscribe"), worktreeId: id }),
  z.object({ t: z.literal("unsubscribe"), worktreeId: id }),
  /** the worktree this tab is showing, or null while it shows none or is hidden; sent again on
   * reconnect. Looking is what keeps a worktree's dev servers running and what wakes them. */
  z.object({ t: z.literal("view"), worktreeId: id.nullable() }),
  z.object({
    t: z.literal("chat"),
    worktreeId: id,
    /** the sending tab: a message that brings an archived worktree back focuses it there */
    clientId: z.string().max(64).optional(),
    text: prose,
    context: ambient.optional(),
    attachments,
    boxId,
  }),
  z.object({
    t: z.literal("create-worktree"),
    /** the requesting tab's id, echoed as WorktreeInfo.createdBy so only that tab auto-focuses it */
    clientId: z.string().max(64).optional(),
    repoId: id,
    /** the provisional row the message was typed in: that very row becomes the worktree, so
     * nothing on screen swaps. Another tab may have claimed it first, in which case a fresh one is
     * made and `clientId` says which tab focuses it. */
    worktreeId: id.optional(),
    prompt,
    /** how many attempts at the one prompt, made as a group; one when absent */
    variants: z.number().int().min(1).max(VARIANTS_MAX).optional(),
    context: ambient.optional(),
    attachments,
    /** registry id; the daemon's default when absent */
    agent: id.optional(),
    /** one of the repo's profiles; its defaultProfile when absent */
    profile: z.string().max(100).optional(),
    /** what the agent may do without asking; the default mode when absent */
    mode: permissionModeSchema.optional(),
    /** one of the agent's advertised model ids; its own default when absent */
    model: z.string().max(200).optional(),
    /** one of the agent's advertised effort levels; its own default when absent */
    effort: z.string().max(100).optional(),
    /** move main's uncommitted changes into the new worktree; only for a single worktree from main */
    carry: z.boolean().optional(),
    boxId,
  }),
  z.object({
    t: z.literal("batch-worktrees"),
    repoId: id,
    prompt,
    agent: id.optional(),
    /** as on create-worktree; every planned worktree asks for the same model and effort */
    model: z.string().max(200).optional(),
    effort: z.string().max(100).optional(),
    boxId,
  }),
  /** change what the agent may do here without asking; takes effect on its next turn */
  z.object({ t: z.literal("set-worktree-mode"), worktreeId: id, mode: permissionModeSchema }),
  /** ask the agent to run another of its models here; takes effect on its next turn */
  z.object({ t: z.literal("set-worktree-model"), worktreeId: id, model: z.string().max(200) }),
  /** ask the agent to run at another of its effort levels here; takes effect on its next turn */
  z.object({ t: z.literal("set-worktree-effort"), worktreeId: id, effort: z.string().max(100) }),
  /** run this worktree under another of the repo's profiles: its procs restart, the agent stays */
  z.object({ t: z.literal("set-worktree-profile"), worktreeId: id, profile: z.string().max(100) }),
  /** run the named shared-tier procs here rather than reaching main's; every borrowed one when
   * `names` is absent */
  z.object({ t: z.literal("own-procs"), worktreeId: id, names: z.array(procName).max(50).optional() }),
  /** stop the shared-tier procs this worktree runs itself and reach main's again */
  z.object({ t: z.literal("share-procs"), worktreeId: id }),
  /** archive a worktree: its directory and branch go, its chat and work are kept, and the rail's
   * archived section offers to restore it */
  z.object({ t: z.literal("archive-worktree"), worktreeId: id }),
  /** the project's archived worktrees; replies `archived` */
  z.object({ t: z.literal("list-archived"), repoId: id }),
  /** bring an archived worktree back: its directory, branch, uncommitted work and chat */
  z.object({
    t: z.literal("restore-worktree"),
    archiveId: id,
    /** as on create-worktree: only the tab that asked focuses the restored row */
    clientId: z.string().max(64).optional(),
    /** typed into the archived chat: the message goes to the agent once the worktree is back */
    message: z.object({ text: prose, attachments }).optional(),
    /** the box `message` was written in */
    boxId,
  }),
  /** delete an archived worktree for good: its chat, attachments and the commits kept for it */
  z.object({ t: z.literal("delete-archived"), archiveId: id }),
  /** take over a worktree git knows about but toyon did not create: the row's id, which the
   * daemon resolves to a path and then re-derives the list for, refusing anything not still on it */
  z.object({
    t: z.literal("adopt-worktree"),
    /** as on create-worktree: only the tab that asked focuses the promoted row */
    clientId: z.string().max(64).optional(),
    worktreeId: id,
    /** typed into the found worktree's box: the message goes to the agent once the row is toyon's */
    message: z.object({ text: prose, attachments }).optional(),
    /** the box `message` was written in */
    boxId,
  }),
  z.object({ t: z.literal("git-status"), worktreeId: id }),
  /** the file as the working tree has it, beside what it was at the merge-base with main; `ref`
   * reads it as that commit left it instead, and `since` keeps the working tree's copy and puts
   * that commit's beside it. Answered by exactly one `file-read`. */
  z.object({
    t: z.literal("read-file"),
    worktreeId: id,
    path: relPath,
    ref: sha.optional(),
    since: sha.optional(),
    seq,
  }),
  /** who last touched each line of the file, for the ghost after the caret's line; `ref` blames the
   * file as that commit left it. Answered by exactly one `file-blame`. */
  z.object({ t: z.literal("blame-file"), worktreeId: id, path: relPath, ref: sha.optional(), seq }),
  /** the branch's commits for the history tab */
  z.object({ t: z.literal("git-log"), worktreeId: id }),
  /** the files one commit touched, on expanding it in the history tab */
  z.object({ t: z.literal("git-commit"), worktreeId: id, sha }),
  /** the one press: commit if dirty (with `message`, else the suggested one), take main in, then
   * the repo's route: merge here, merge and push, or push and open a PR. On a worktree whose PR
   * is open it pushes the work the PR lacks, or merges the PR once there is none. Stops at the
   * first step that fails. */
  z.object({ t: z.literal("land"), worktreeId: id, message: z.string().max(5_000).optional() }),
  z.object({ t: z.literal("commit"), worktreeId: id, message: z.string().max(5_000) }),
  /** merge the sources' branches into the target worktree and remove them; a local merge, and the
   * target keeps its agent, procs and port */
  z.object({ t: z.literal("graft"), targetId: id, sourceIds: z.array(id).min(1).max(20) }),
  z.object({ t: z.literal("sync-main"), worktreeId: id }),
  /** run the repo's `afterLand` now: the manual half of the notice that toyon's own bundles are
   * behind the checkout it runs from */
  z.object({ t: z.literal("run-after-land"), repoId: id }),
  /** stop the daemon and start it again from the same entry. A chat mid-reply is waited out, and
   * the wait is announced in `update`. Every shell reconnects on its own, so this is the only frame
   * that answers by going away. */
  z.object({ t: z.literal("restart-daemon") }),
  /** try a failed update again: install the newest Toyon and restart onto it once no chat is
   * mid-reply */
  z.object({ t: z.literal("update-now") }),
  /** a press on the version chip: ask the registry now. A newer version announces itself in
   * `update`, and whatever the check found comes back as `update-checked`, since a check that
   * finds nothing would otherwise say nothing. */
  z.object({ t: z.literal("check-update") }),
  /** fast-forward the main checkout (`worktreeId` is main's row) to its upstream */
  z.object({ t: z.literal("pull-main"), worktreeId: id }),
  /** save the editor's text only over `base`, the version it was read or last saved as (null: no
   * file). Answered by exactly one `file-written`. */
  z.object({
    t: z.literal("write-file"),
    worktreeId: id,
    path: relPath,
    content: z.string().max(FILE_MAX_CHARS),
    base: z.string().max(64).nullable(),
    seq,
  }),
  /** a link in the chat to a file outside this worktree, by its absolute path: opened as the Dock
   * icon opens one, in the worktree it sits in or loose under a grant. Answered by one `open-path`
   * or `open-loose` to this socket, or by one `open-refused` carrying the seq. */
  z.object({ t: z.literal("open-by-path"), path: relPath, seq }),
  /** save a granted file's text only over `base`, the version open-loose or the last save named.
   * Answered by exactly one `loose-written`. */
  z.object({
    t: z.literal("write-loose"),
    id,
    content: z.string().max(FILE_MAX_CHARS),
    base: z.string().max(64).nullable(),
    seq,
  }),
  z.object({ t: z.literal("list-files"), worktreeId: id }),
  /** open the `/` menu on a worktree whose agent has not run yet: start it so it says what
   * commands it has. Answered by an `agent-commands` push, or by nothing if it will not start. */
  z.object({ t: z.literal("list-commands"), worktreeId: id }),
  z.object({ t: z.literal("search"), worktreeId: id, query: z.string().max(500) }),
  /** a ⌘I pick on a page that recorded no file: find the element in the source by what it shows.
   * Answered by one `element-sources`. */
  z.object({ t: z.literal("find-element"), worktreeId: id, seq, element: elementTraitsSchema }),
  z.object({ t: z.literal("design-scan"), worktreeId: id }),
  /** throw away the uncommitted changes to these files: one row's, or every row checked in the
   * changes list. One message for the set, so the status push and the check run once after all of
   * them rather than once per file. */
  z.object({ t: z.literal("discard-files"), worktreeId: id, paths: z.array(relPath).min(1).max(500) }),
  /** run the repo's check here and write the recap and the commit message, by hand: for a verdict
   * the tree moved under, a turn that stopped short of one, or none at all. Answered by the
   * worktree's landing on the rows frame; refused while its agent is mid-turn. A `note` is what
   * the person typed after the verb, for the commit message to carry. */
  z.object({ t: z.literal("judge"), worktreeId: id, note: z.string().max(500).optional() }),
  /** send the worktree's agent the turn that fixes a dev server that crashed or never answered;
   * on a lead, whose box starts work, the fix is the worktree that box would start. `clientId` as
   * on create-worktree. */
  z.object({ t: z.literal("fix-preview"), worktreeId: id, clientId: z.string().max(64).optional() }),
  z.object({ t: z.literal("reveal"), worktreeId: id, path: relPath.optional() }),
  z.object({ t: z.literal("stop-agent"), worktreeId: id }),
  /** the person is looking at this worktree right now: clears the rail's unseen ring */
  z.object({ t: z.literal("seen"), worktreeId: id }),
  /** put the ring back on a worktree to come back to; the next `seen` clears it */
  z.object({ t: z.literal("mark-unread"), worktreeId: id }),
  /** a composer box's unsent text as it stands, so another tab or device, and an archive, keep it;
   * `boxId` is a worktree's id or a repo's new-worktree draft */
  z.object({ t: z.literal("set-draft"), boxId: id, text: prose, clientId: z.string().max(64).optional() }),
  /** what is attached in a composer box and not yet sent, kept beside its text for the same reasons */
  z.object({
    t: z.literal("set-attachments"),
    boxId: id,
    items: attachmentList,
    clientId: z.string().max(64).optional(),
  }),
  /** the window came back from another app, where files may have changed: recount the project's
   * rows and re-read its open changes lists */
  z.object({ t: z.literal("refresh-git"), repoId: id }),
  /** the preview settled on a page (the shell waits out redirects): count it toward the repo's
   * list. `path` is the page's key (routeKey), which the daemon recomputes rather than trusts, and
   * `title` the document's when the dwell ended. */
  z.object({ t: z.literal("visit"), worktreeId: id, path: routePath, title: pageTitle.optional() }),
  /** a counted page's title settled later: renames it without counting another visit */
  z.object({ t: z.literal("page-title"), worktreeId: id, path: routePath, title: pageTitle }),
  /** take a page off the repo's list */
  z.object({ t: z.literal("forget-visit"), repoId: id, path: routePath }),
  z.object({ t: z.literal("pick-variant"), worktreeId: id }),
  /** take a waiting message out of the queue; with `edit`, back into the worktree's box, words and chips */
  z.object({
    t: z.literal("unqueue"),
    worktreeId: id,
    index: z.number().int().min(0),
    edit: z.boolean().optional(),
  }),
  /** a message already sent, back into the worktree's box to be said again with a change: its
   * words, and what it carried. `seq` is its place in the transcript. */
  z.object({ t: z.literal("redraft"), worktreeId: id, seq: z.number().int().min(0) }),
  z.object({ t: z.literal("changed-ranges"), worktreeId: id, path: relPath }),
  z.object({ t: z.literal("rename-worktree"), worktreeId: id, title: z.string().min(1).max(200) }),
  /** `kind` is the setup pane's answer to committed or kept local: which of the pair the save
   * writes, in the place the settings already are; the sibling it displaces is taken away */
  z.object({
    t: z.literal("confirm-config"),
    repoId: id,
    config: toyonConfigSchema,
    kind: z.enum(["shared", "local"]),
  }),
  /** open another repo in this daemon (the project switcher's "open folder"); `~` is expanded */
  z.object({ t: z.literal("register-repo"), path: z.string().min(1).max(4_000) }),
  /** make a project where there was not one and open it: a new folder, a clone of a remote, or an
   * empty folder that is already there (`init`, where `name` is that folder's own name). `parent`
   * and `name` stay apart because the rule is structural (exactly one leaf under a parent that
   * already exists), and rebuilding it by splitting a joined string daemon side would let the row
   * promise something the daemon then refuses. `~` is expanded daemon side. */
  z
    .object({
      t: z.literal("create-repo"),
      mode: z.enum(["create", "clone", "init"]),
      parent: z.string().min(1).max(4_000),
      name: z.string().min(1).max(100),
      /** clone only: what to clone from. Any git remote, not just GitHub */
      url: z.string().min(1).max(2_000).optional(),
      /** git's name and email, written to the global config before the first commit, for someone
       * whose git has none (hello's `gitIdentity`) */
      identity: z
        .object({ name: z.string().trim().min(1).max(200), email: z.string().trim().min(1).max(254) })
        .optional(),
    })
    .superRefine((m, ctx) => {
      if (m.mode === "clone" && !m.url) ctx.addIssue({ code: "custom", path: ["url"], message: "a clone needs a url" });
      if (m.mode !== "clone" && m.url)
        ctx.addIssue({ code: "custom", path: ["url"], message: "only a clone takes a url" });
    }),
  /** take back a project toyon made (`RepoInfo.made`) that is still exactly as it was made: forget it
   * and remove what was made, so the new-project page can make it again under another name or place */
  z.object({ t: z.literal("unmake-repo"), repoId: id }),
  /** stop a clone that is still running and forget it; the half-made folder goes with it */
  z.object({ t: z.literal("cancel-import"), id }),
  /** what directories could complete this partial path (project picker autocomplete) */
  z.object({ t: z.literal("browse-path"), path: z.string().max(4_000) }),
  /** open the OS folder dialog at `start`, for where a new project goes or for a project folder to
   * open (the new-project page's two folder controls, which the dialog's prompt names); answered with
   * `folder-chosen` */
  z.object({
    t: z.literal("choose-folder"),
    start: z.string().max(4_000),
    purpose: z.enum(["location", "open"]),
  }),
  /** close the dialog `choose-folder` opened: Escape in the shell while it is up, or the form closing */
  z.object({ t: z.literal("cancel-folder") }),
  /** drop a repo from the daemon; refused while it still has task worktrees */
  z.object({ t: z.literal("forget-repo"), repoId: id }),
  z.object({ t: z.literal("set-theme"), prefs: themePrefsSchema }),
  /** the browser's own IANA timezone, which is the only place the person's longitude is known: a
   * cloud daemon sits in whatever zone its VM does. Answered with `daylight`. */
  z.object({ t: z.literal("zone"), tz: z.string().max(100) }),
  z.object({ t: z.literal("set-default-agent"), agent: id }),
  z.object({ t: z.literal("set-keep-awake"), mode: z.enum(KEEP_AWAKE_MODES) }),
  /** (re)download an agent's adapter; progress arrives as `agents` broadcasts */
  z.object({ t: z.literal("install-agent"), agent: id }),
  /** log the worktree's agent in with one of the methods it offered; a key rides along when asked for */
  z.object({
    t: z.literal("agent-auth"),
    worktreeId: id,
    methodId: z.string().max(100),
    apiKey: z.string().max(1000).optional(),
  }),
  /** send the message that was refused for want of credentials again */
  z.object({ t: z.literal("agent-retry"), worktreeId: id }),
  /** answer an open question card. `answers` is positional, one per question the card asked;
   * leaving it out is the skip button, which the agent hears as "the person passed" */
  z.object({
    t: z.literal("agent-answer"),
    worktreeId: id,
    askId: z.string().max(64),
    answers: z.array(askAnswerSchema).max(8).optional(),
  }),
  /** click one of the options on a permission card */
  z.object({ t: z.literal("agent-decide"), worktreeId: id, askId: z.string().max(64), choiceId: z.string().max(200) }),
  /** drop this agent's stored credential (ACP logout), whatever worktree it was logged in from */
  z.object({ t: z.literal("agent-logout"), agent: id }),
  /** settings: the files this agent reads and the MCP servers it will load, for the repo when given */
  z.object({ t: z.literal("agent-config"), agent: id, repoId: id.optional() }),
  /** reveal one of those files in Finder; `file` is the id the agent-config reply named */
  z.object({ t: z.literal("reveal-agent-file"), agent: id, file: z.string().max(64), repoId: id.optional() }),
  /** raw VS Code theme JSON/JSONC text picked in the browser */
  z.object({ t: z.literal("import-theme"), name: z.string().max(300), source: z.string().max(2_000_000) }),
  z.object({ t: z.literal("rescan-themes") }),
  /** open (or reopen) one of the worktree's streams at this size and receive it; replies
   * term-snapshot. `stream` is SHELL_STREAM or a proc's name. */
  z.object({ t: z.literal("term-open"), worktreeId: id, stream: streamName, cols: termSize, rows: termSize }),
  z.object({ t: z.literal("term-input"), worktreeId: id, stream: streamName, data: termInput }),
  z.object({ t: z.literal("term-resize"), worktreeId: id, stream: streamName, cols: termSize, rows: termSize }),
  /** restart the stream: a proc goes back under supervision, the shell comes back empty */
  z.object({ t: z.literal("term-restart"), worktreeId: id, stream: streamName }),
  /** the tab went away: stop streaming to this socket (the stream keeps running) */
  z.object({ t: z.literal("term-close"), worktreeId: id, stream: streamName }),
  /** run one command in the worktree (a `!` message from the composer): no reply frame, the result
   * arrives on the agent stream as a tool-start / tool-end pair under SHELL_TOOL */
  z.object({ t: z.literal("exec"), worktreeId: id, command: shellCommand.min(1) }),
  /** kill the command running under this row: its whole process group, so what it started goes
   * with it. Two commands at once each have a stop of their own. */
  z.object({ t: z.literal("exec-stop"), worktreeId: id, toolId: id }),
  /** kill the run of that kind out on the worktree (its setup command, its check, its commit with
   * the hooks in it); the run's own end reports it as terminated */
  z.object({ t: z.literal("run-stop"), worktreeId: id, kind: z.enum(["setup", "check", "commit"]) }),
  /** start the procs of a parked worktree: one back from the archive, or one taken over */
  z.object({ t: z.literal("preview-start"), worktreeId: id }),
  /** the ref palette: local branches, remote branches and open PRs matching the query; replies
   * `refs`. An empty query lists the work that is open. */
  z.object({ t: z.literal("search-refs"), repoId: id, query: z.string().max(200) }),
  /** what the project's chats say, live worktrees and archived ones: the person's messages and the
   * model's prose, never tool output; replies `chat-hits` */
  z.object({ t: z.literal("search-chats"), repoId: id, query: z.string().max(200) }),
  /** open a ref as a worktree toyon owns. `ref` is what the `refs` reply carried; a PR's title and
   * url ride along for the record, since only the hit knew them. */
  z.object({
    t: z.literal("open-ref"),
    /** as on create-worktree: only the tab that asked focuses the new row */
    clientId: z.string().max(64).optional(),
    repoId: id,
    kind: z.enum(["branch", "remote", "pr"]),
    ref: z.string().min(1).max(300),
    pr: z.object({ title: z.string().max(300), url: z.string().max(500) }).optional(),
  }),
]);

export type ClientMsg = z.infer<typeof clientMsgSchema>;

/** a failed parse as one line: where, then why. Zod wraps the issue a record key or an array element
 * raised in a generic one ("Invalid key in record"), which is all the person would read about a proc
 * named "shell", so the reason is read from the innermost issue and the paths are joined on the way. */
export function issueReason(error: z.ZodError, fallback: string): string {
  let issue = error.issues[0];
  let path: PropertyKey[] = issue?.path ?? [];
  while (issue && (issue.code === "invalid_key" || issue.code === "invalid_element") && issue.issues[0]) {
    issue = issue.issues[0];
    path = [...path, ...issue.path];
  }
  // a union names every branch's complaint; the one whose shape the input had (a list given a
  // list) is the branch that got past the type check, and its first issue is the reason
  if (issue?.code === "invalid_union") {
    const branch = issue.errors.find((errs) => errs[0]?.code !== "invalid_type") ?? issue.errors[0];
    const inner = branch?.[0];
    if (inner) {
      path = [...path, ...inner.path];
      return `${path.length ? `${path.map(String).join(".")}: ` : ""}${inner.message}`;
    }
  }
  const where = path.length ? `${path.map(String).join(".")}: ` : "";
  return `${where}${issue?.message ?? fallback}`;
}

/** parse one inbound frame; returns the message or a one-line reason */
export function parseClientMsg(raw: unknown): { ok: true; msg: ClientMsg } | { ok: false; reason: string } {
  const r = clientMsgSchema.safeParse(raw);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, reason: issueReason(r.error, "invalid message") };
}

// The hand-written interfaces in model.ts / events.ts and the schemas above must describe the same
// shapes. These compile-time checks fail the build if either side drifts.
type Same<A, B> = A extends B ? (B extends A ? true : never) : never;
const _pickMeta: Same<z.infer<typeof pickMetaSchema>, PickMeta> = true;
const _config: Same<z.infer<typeof toyonConfigSchema>, ToyonConfig> = true;
const _prefs: Same<z.infer<typeof themePrefsSchema>, ThemePrefs> = true;
const _askAnswer: Same<z.infer<typeof askAnswerSchema>, AskAnswer> = true;
const _pasteSource: Same<z.infer<typeof pasteSourceSchema>, PasteSource> = true;
const _pickRef: Same<z.infer<typeof pickInputSchema>, Omit<PickRef, "n">> = true;
void _pickMeta;
void _pasteSource;
void _pickRef;
void _config;
void _prefs;
