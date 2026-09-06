// Daemon ↔ shell WebSocket protocol.
//
// ServerMsg is a plain TypeScript union: the daemon is trusted and `satisfies ServerMsg` on every
// send keeps it honest. ClientMsg is a zod schema, and the type is inferred from it: client frames
// arrive from a browser (public internet in cloud mode) and are validated before any handler runs.

import { z } from "zod";
import type {
  GitFileStatus,
  RepoInfo,
  Theme,
  ThemePrefs,
  ToyonConfig,
  WorktreeInfo,
  WorktreeStatus,
} from "../model.ts";
import type { AgentEvent, PickMeta } from "./events.ts";

/** bump when a ServerMsg/ClientMsg shape changes incompatibly; the shell compares it on hello */
export const PROTOCOL_VERSION = 2;

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
    }
  | { t: "themes"; themes: Theme[]; prefs: ThemePrefs }
  | { t: "repos"; repos: RepoInfo[] }
  | { t: "worktrees"; worktrees: WorktreeStatus[] }
  | { t: "proc"; worktreeId: string; proc: WorktreeStatus["procs"][number] }
  | { t: "log"; worktreeId: string; proc: string; line: string }
  | { t: "agent"; worktreeId: string; seq: number; event: AgentEvent }
  /** on subscribe: the transcript so far and the dev servers' recent output */
  | { t: "backfill"; worktreeId: string; events: Array<{ seq: number; event: AgentEvent }>; log?: string[] }
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
  | { t: "changed-ranges"; worktreeId: string; path: string; ranges: Array<[number, number]>; lineOffset: number }
  | { t: "error"; message: string };

// ---- client → daemon: schemas are the source of truth ----

const id = z.string().min(1).max(200);
/** a worktree-relative path; the daemon still canonicalises and bounds it (resolveInside) */
const relPath = z.string().min(1).max(4096);
/** a chat message or its ambient context */
const prose = z.string().max(200_000);
const prompt = z.string().max(20_000);
const shellCommand = z.string().max(2_000);

export const pickMetaSchema = z.object({
  component: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  tag: z.string(),
  selector: z.string(),
});

export const toyonConfigSchema = z.object({
  procs: z.record(z.string().max(100), shellCommand),
  setup: z.array(shellCommand).max(50).optional(),
  preview: z.string().max(100).optional(),
  exclusive: z.boolean().optional(),
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
  }),
  z.object({ t: z.literal("batch-worktrees"), repoId: id, prompt }),
  z.object({ t: z.literal("remove-worktree"), worktreeId: id }),
  z.object({ t: z.literal("restart-proc"), worktreeId: id, proc: z.string() }),
  z.object({ t: z.literal("git-status"), worktreeId: id }),
  z.object({ t: z.literal("file-diff"), worktreeId: id, path: relPath }),
  z.object({ t: z.literal("ship"), worktreeId: id }),
  z.object({ t: z.literal("merge-main"), worktreeId: id }),
  z.object({ t: z.literal("commit"), worktreeId: id, message: z.string().max(5_000) }),
  z.object({ t: z.literal("combine"), worktreeIds: z.array(id).min(2).max(20) }),
  z.object({ t: z.literal("sync-main"), worktreeId: id }),
  z.object({ t: z.literal("write-file"), worktreeId: id, path: relPath, content: z.string().max(10_000_000) }),
  z.object({ t: z.literal("list-files"), worktreeId: id }),
  z.object({ t: z.literal("search"), worktreeId: id, query: z.string().max(500) }),
  z.object({ t: z.literal("discard-file"), worktreeId: id, path: relPath }),
  z.object({ t: z.literal("reveal"), worktreeId: id, path: relPath.optional() }),
  z.object({ t: z.literal("stop-agent"), worktreeId: id }),
  z.object({ t: z.literal("pick-variant"), worktreeId: id }),
  z.object({ t: z.literal("unqueue"), worktreeId: id, index: z.number().int().min(0) }),
  z.object({ t: z.literal("changed-ranges"), worktreeId: id, path: relPath }),
  z.object({ t: z.literal("rename-worktree"), worktreeId: id, title: z.string().min(1).max(200) }),
  z.object({ t: z.literal("confirm-config"), repoId: id, config: toyonConfigSchema }),
  z.object({ t: z.literal("set-theme"), prefs: themePrefsSchema }),
  /** raw VS Code theme JSON/JSONC text picked in the browser */
  z.object({ t: z.literal("import-theme"), name: z.string().max(300), source: z.string().max(2_000_000) }),
  z.object({ t: z.literal("rescan-themes") }),
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
void _pickMeta;
void _config;
void _prefs;
void _variant;
