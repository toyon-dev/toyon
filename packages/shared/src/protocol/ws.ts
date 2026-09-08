// Daemon ↔ shell WebSocket protocol.
//
// ServerMsg is a plain TypeScript union: the daemon is trusted and `satisfies ServerMsg` on every
// send keeps it honest. ClientMsg is a zod schema, and the type is inferred from it: client frames
// arrive from a browser (public internet in cloud mode) and are validated before any handler runs.

import { z } from "zod";
import type {
  AgentInfo,
  GitFileStatus,
  LogLine,
  PathEntry,
  RepoInfo,
  Theme,
  ThemePrefs,
  ToyonConfig,
  WorktreeInfo,
  WorktreeStatus,
} from "../model.ts";
import { SHELL_STREAM } from "../model.ts";
import type { AgentCommand, AgentEvent, AskAnswer, PickMeta } from "./events.ts";

/**
 * Bump when a ServerMsg/ClientMsg shape changes incompatibly; the shell compares it on hello and
 * stops talking rather than misreading frames.
 *
 * A *new* ClientMsg kind counts, however additive it looks: the shell ships from dist and the
 * daemon from source, so a reloaded tab routinely talks to a daemon that has not restarted, and
 * an unknown `t` there is a zod failure the person reads as a wall of discriminator values. The
 * same goes for a new required field on an existing kind.
 */
export const PROTOCOL_VERSION = 9;

/** one content-search match: path + 1-based line + the (trimmed) line text */
export type SearchHit = { path: string; line: number; text: string };

export type ServerMsg =
  | {
      t: "hello";
      version: string;
      protocol: number;
      repos: RepoInfo[];
      worktrees: WorktreeStatus[];
      themes: Theme[];
      themePrefs: ThemePrefs;
      /** the daemon's agent registry and which entry new worktrees get by default */
      agents: AgentInfo[];
      defaultAgent: string;
    }
  | { t: "themes"; themes: Theme[]; prefs: ThemePrefs }
  | { t: "agents"; agents: AgentInfo[]; defaultAgent: string }
  | { t: "repos"; repos: RepoInfo[] }
  /** directories matching what the project picker has typed so far */
  | { t: "path-entries"; query: string; entries: PathEntry[] }
  | { t: "worktrees"; worktrees: WorktreeStatus[] }
  | { t: "proc"; worktreeId: string; proc: WorktreeStatus["procs"][number] }
  | { t: "log"; worktreeId: string; proc: string; line: string }
  | { t: "agent"; worktreeId: string; seq: number; event: AgentEvent }
  /** on subscribe: the transcript so far and the dev servers' recent output */
  | { t: "backfill"; worktreeId: string; events: Array<{ seq: number; event: AgentEvent }>; log?: LogLine[] }
  | {
      t: "git-status";
      worktreeId: string;
      files: GitFileStatus[];
      committed?: GitFileStatus[];
      ahead?: number;
      behind?: number;
    }
  | { t: "file-diff"; worktreeId: string; path: string; before: string; after: string }
  | {
      t: "shipped";
      worktreeId: string;
      ok: boolean;
      url?: string;
      message: string;
      merged?: boolean;
      removeIds?: string[];
      suggestion?: string;
    }
  | { t: "files"; worktreeId: string; paths: string[] }
  | { t: "search-results"; worktreeId: string; query: string; hits: SearchHit[]; truncated: boolean }
  | { t: "queue"; worktreeId: string; items: string[] }
  /** the slash commands this worktree's agent session advertises. Ephemeral, never a transcript
   * event (the backfill trims to the last 1000), so it is replayed on subscribe like `queue`. */
  | { t: "agent-commands"; worktreeId: string; commands: AgentCommand[] }
  | { t: "changed-ranges"; worktreeId: string; path: string; ranges: Array<[number, number]>; lineOffset: number }
  /** raw stream output; only to sockets that opened that exact tab (term-open) */
  | { t: "term-data"; worktreeId: string; stream: string; data: string }
  /** reply to term-open: the recent output to replay into a reset terminal */
  | { t: "term-snapshot"; worktreeId: string; stream: string; data: string; alive: boolean }
  | { t: "term-exit"; worktreeId: string; stream: string; exitCode: number }
  | { t: "error"; message: string };

/** the terminal stream: bytes for xterm, which the shell routes around its store */
export type TermServerMsg = Extract<ServerMsg, { t: "term-data" | "term-snapshot" | "term-exit" }>;
export function isTermMsg(m: ServerMsg): m is TermServerMsg {
  return m.t === "term-data" || m.t === "term-snapshot" || m.t === "term-exit";
}

// ---- client → daemon: schemas are the source of truth ----

const id = z.string().min(1).max(200);
/** a worktree-relative path; the daemon still canonicalises and bounds it (resolveInside) */
const relPath = z.string().min(1).max(4096);
/** a chat message or its ambient context */
const prose = z.string().max(200_000);
const prompt = z.string().max(20_000);
const shellCommand = z.string().max(2_000);
const termSize = z.number().int().min(1).max(500);
/** keystrokes, or a paste the shell chunks */
const termInput = z.string().max(65_536);
/** which of a worktree's streams: SHELL_STREAM, or a proc named in toyon.json */
const streamName = z.string().min(1).max(100);

/** image formats the models accept; the shell re-encodes anything else (and anything too large) */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
/** the models' long-edge ceiling; the shell downscales to it before sending */
export const IMAGE_MAX_EDGE = 2576;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGES_PER_MESSAGE = 6;

/** an image as the shell sends it: already downscaled, base64 so it rides in the JSON frame */
export const imageInputSchema = z.object({
  name: z.string().max(200),
  mimeType: z.enum(IMAGE_MIME_TYPES),
  /** base64 (no data: prefix); 4/3 of the byte cap, rounded up to the next multiple of 4 */
  data: z.string().max(Math.ceil((IMAGE_MAX_BYTES * 4) / 3 / 4) * 4),
  width: z.number().int().min(1).max(IMAGE_MAX_EDGE),
  height: z.number().int().min(1).max(IMAGE_MAX_EDGE),
});
export type ImageInput = z.infer<typeof imageInputSchema>;
const images = z.array(imageInputSchema).max(IMAGES_PER_MESSAGE).optional();

/** when a paste collapses into a chip instead of filling the textarea. Either bound trips it: a
 * wall of prose has few lines, a stack trace has short ones. */
export const PASTE_MIN_CHARS = 1200;
export const PASTE_MIN_LINES = 10;
export const PASTE_MAX_CHARS = 100_000;
export const PASTES_PER_MESSAGE = 4;

/** a paste as the shell sends it; the daemon derives the counts rather than trusting them */
export const pasteInputSchema = z.object({
  text: z.string().min(1).max(PASTE_MAX_CHARS),
  /** the file it came from, when it was pasted or dropped as one */
  name: z.string().max(200).optional(),
});
export type PasteInput = z.infer<typeof pasteInputSchema>;
const pastes = z.array(pasteInputSchema).max(PASTES_PER_MESSAGE).optional();

/** one question's answer on an ask card: the option values chosen, and the note typed beside them */
const askAnswerSchema = z.object({
  selected: z.array(z.string().max(2_000)).max(32),
  note: z.string().max(10_000).optional(),
});

export const pickMetaSchema = z.object({
  component: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  tag: z.string(),
  selector: z.string(),
});

const procName = z.string().max(100);
/** a proc is a tab in the terminal pane, so it cannot take the shell's name out from under it */
const declaredProcName = procName.refine((n) => n !== SHELL_STREAM, `"${SHELL_STREAM}" is reserved for the shell tab`);
const runProfileSchema = z.object({
  procs: z.array(procName).max(50),
  env: z.record(z.string().max(100), z.string().max(2_000)).optional(),
  preview: procName.optional(),
});

export const toyonConfigSchema = z
  .object({
    procs: z.record(declaredProcName, shellCommand),
    setup: z.array(shellCommand).max(50).optional(),
    preview: procName.optional(),
    exclusive: z.boolean().optional(),
    profiles: z.record(procName, runProfileSchema).optional(),
    defaultProfile: procName.optional(),
  })
  .superRefine((c, ctx) => {
    // a profile may only name procs that exist, and the default must be a profile: caught here so
    // a typo is a toast at confirm/reload time, not a worktree that silently runs nothing
    if (!c.profiles) {
      if (c.defaultProfile !== undefined)
        ctx.addIssue({ code: "custom", path: ["defaultProfile"], message: "defaultProfile without profiles" });
      return;
    }
    for (const [name, p] of Object.entries(c.profiles)) {
      for (const proc of p.procs) {
        if (!(proc in c.procs))
          ctx.addIssue({ code: "custom", path: ["profiles", name, "procs"], message: `unknown proc "${proc}"` });
      }
      if (p.preview !== undefined && !p.procs.includes(p.preview))
        ctx.addIssue({ code: "custom", path: ["profiles", name, "preview"], message: "preview is not in procs" });
    }
    if (c.defaultProfile === undefined)
      ctx.addIssue({ code: "custom", path: ["defaultProfile"], message: "required when profiles are set" });
    else if (!(c.defaultProfile in c.profiles))
      ctx.addIssue({ code: "custom", path: ["defaultProfile"], message: `unknown profile "${c.defaultProfile}"` });
  });

export const themePrefsSchema = z.object({
  mode: z.enum(["dark", "light", "system"]),
  light: z.string(),
  dark: z.string(),
});

const variantSchema = z.object({ group: z.string(), index: z.number().int().min(1), of: z.number().int().min(1) });

export const clientMsgSchema = z.discriminatedUnion("t", [
  /** receive this worktree's stream (agent events, logs, queue, git status); replies with a backfill */
  z.object({ t: z.literal("subscribe"), worktreeId: id }),
  z.object({ t: z.literal("unsubscribe"), worktreeId: id }),
  z.object({
    t: z.literal("chat"),
    worktreeId: id,
    text: prose,
    context: prose.optional(),
    pick: pickMetaSchema.optional(),
    images,
    pastes,
  }),
  z.object({
    t: z.literal("create-worktree"),
    /** the requesting tab's id, echoed as WorktreeInfo.createdBy so only that tab auto-focuses it */
    clientId: z.string().max(64).optional(),
    repoId: id,
    prompt,
    baseWorktreeId: id.optional(),
    variant: variantSchema.optional(),
    context: prose.optional(),
    pick: pickMetaSchema.optional(),
    images,
    pastes,
    /** registry id; the daemon's default when absent */
    agent: id.optional(),
    /** one of the repo's profiles; its defaultProfile when absent */
    profile: z.string().max(100).optional(),
  }),
  z.object({ t: z.literal("batch-worktrees"), repoId: id, prompt, agent: id.optional() }),
  /** run this worktree under another of the repo's profiles: its procs restart, the agent stays */
  z.object({ t: z.literal("set-worktree-profile"), worktreeId: id, profile: z.string().max(100) }),
  z.object({ t: z.literal("remove-worktree"), worktreeId: id }),
  z.object({ t: z.literal("git-status"), worktreeId: id }),
  z.object({ t: z.literal("file-diff"), worktreeId: id, path: relPath }),
  z.object({ t: z.literal("ship"), worktreeId: id }),
  z.object({ t: z.literal("merge-main"), worktreeId: id }),
  z.object({ t: z.literal("commit"), worktreeId: id, message: z.string().max(5_000) }),
  z.object({ t: z.literal("combine"), worktreeIds: z.array(id).min(2).max(20) }),
  z.object({ t: z.literal("sync-main"), worktreeId: id }),
  z.object({ t: z.literal("write-file"), worktreeId: id, path: relPath, content: z.string().max(10_000_000) }),
  z.object({ t: z.literal("list-files"), worktreeId: id }),
  /** open the `/` menu on a worktree whose agent has not run yet: start it so it says what
   * commands it has. Answered by an `agent-commands` push, or by nothing if it will not start. */
  z.object({ t: z.literal("list-commands"), worktreeId: id }),
  z.object({ t: z.literal("search"), worktreeId: id, query: z.string().max(500) }),
  z.object({ t: z.literal("discard-file"), worktreeId: id, path: relPath }),
  z.object({ t: z.literal("reveal"), worktreeId: id, path: relPath.optional() }),
  z.object({ t: z.literal("stop-agent"), worktreeId: id }),
  z.object({ t: z.literal("pick-variant"), worktreeId: id }),
  z.object({ t: z.literal("unqueue"), worktreeId: id, index: z.number().int().min(0) }),
  z.object({ t: z.literal("changed-ranges"), worktreeId: id, path: relPath }),
  z.object({ t: z.literal("rename-worktree"), worktreeId: id, title: z.string().min(1).max(200) }),
  z.object({ t: z.literal("confirm-config"), repoId: id, config: toyonConfigSchema }),
  /** open another repo in this daemon (the project switcher's "open folder"); `~` is expanded */
  z.object({ t: z.literal("register-repo"), path: z.string().min(1).max(4_000) }),
  /** what directories could complete this partial path (project picker autocomplete) */
  z.object({ t: z.literal("browse-path"), path: z.string().max(4_000) }),
  /** drop a repo from the daemon; refused while it still has task worktrees */
  z.object({ t: z.literal("forget-repo"), repoId: id }),
  z.object({ t: z.literal("set-theme"), prefs: themePrefsSchema }),
  z.object({ t: z.literal("set-default-agent"), agent: id }),
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
]);

export type ClientMsg = z.infer<typeof clientMsgSchema>;

/** parse one inbound frame; returns the message or a one-line reason */
export function parseClientMsg(raw: unknown): { ok: true; msg: ClientMsg } | { ok: false; reason: string } {
  const r = clientMsgSchema.safeParse(raw);
  if (r.success) return { ok: true, msg: r.data };
  const issue = r.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return { ok: false, reason: `${where}${issue?.message ?? "invalid message"}` };
}

// The hand-written interfaces in model.ts / events.ts and the schemas above must describe the same
// shapes. These compile-time checks fail the build if either side drifts.
type Same<A, B> = A extends B ? (B extends A ? true : never) : never;
const _pickMeta: Same<z.infer<typeof pickMetaSchema>, PickMeta> = true;
const _config: Same<z.infer<typeof toyonConfigSchema>, ToyonConfig> = true;
const _prefs: Same<z.infer<typeof themePrefsSchema>, ThemePrefs> = true;
const _variant: Same<z.infer<typeof variantSchema>, NonNullable<WorktreeInfo["variant"]>> = true;
const _askAnswer: Same<z.infer<typeof askAnswerSchema>, AskAnswer> = true;
void _pickMeta;
void _config;
void _prefs;
void _variant;
