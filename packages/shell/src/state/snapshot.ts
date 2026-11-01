// The last-known machine: what this browser keeps of a daemon so a page that cannot reach it
// shows what it last knew. Two shapes, both pure here and written by the machine wiring: the
// hello less what is heavy or the daemon's alone, and the tail of each chat a person opened, with
// the cursors a delta protocol will ask for. Nothing here reads the DOM or the database
// (snapshotStore.ts does that); the reducer runs `recalledHello` through the hello path it already
// has, so a recalled page is the page a hello would make, less what must never read as live.

import {
  type AgentEvent,
  coalesce,
  type HelloFull,
  type PairedMachine,
  PROTOCOL_VERSION,
  type Stamps,
  type TranscriptEntry,
  type TrunkStatus,
  type WorktreeStatus,
} from "@toyon/shared";

/** The hello less what is heavy or the daemon's alone. Left out: themes (the painted one is cached
 * by theme.ts and the store starts with the built-in list; the rest come with the next hello),
 * drafts and attachments (the daemon owns those), knocks and letIn, self, update, globalInstall, pending, and the
 * stamps: the rows come back stilled (below), so the page cannot vouch for them as the daemon sent
 * them, and a stamp it cannot send is not worth keeping. Everything cheap stays, since a recalled
 * hello that invents `install` or `gitIdentity` drives the settings card and the new-project view
 * into the wrong branch. */
export type HelloSnapshot = Omit<
  HelloFull,
  | "t"
  | "same"
  | "themes"
  | "drafts"
  | "attachments"
  | "knocks"
  | "letIn"
  | "self"
  | "update"
  | "globalInstall"
  | "pending"
  | "stamps"
> & {
  /** when this was heard, epoch ms: what the bar's line says the age from */
  at: number;
};

export interface ChatSnapshot {
  protocol: number;
  at: number;
  /** the tail of the transcript, coalesced the way the daemon's backfill is (shared `coalesce`),
   * so the cap counts rows a reader sees and not streamed tokens */
  events: TranscriptEntry[];
  /** the highest raw seq heard: the backfill's `last`, then every live frame's. What the next
   * subscribe sends as `since`, so the daemon answers with the tail alone. */
  seq: number;
  /** what was typed into the box and not sent; on reconnect it wins over the daemon's draft for
   * that box, as a draft typed during a drop does today */
  draft?: string;
}

/** rows a reader sees, per chat kept */
export const CHAT_EVENTS_KEPT = 300;
/** chats kept per machine: the ones opened most recently */
export const CHATS_KEPT = 20;

/** the store's facts a snapshot is taken from: what the hello laid in, under the store's names */
export type MachineFacts = Omit<HelloSnapshot, "at" | "protocol" | "machines" | "machine"> & {
  machine: string | null;
  handed: PairedMachine[];
};

/** The last-known machine as the store holds it, for writing. Null for a machine with nothing to
 * show: no rows and no repos is the sentence, not a snapshot. Every field is named so that a hello
 * field added later is a compile error here rather than a hole in what comes back. */
export function snapshotOf(s: MachineFacts, at: number): HelloSnapshot | null {
  if (s.rows.length === 0 && s.repos.length === 0) return null;
  return {
    protocol: PROTOCOL_VERSION,
    at,
    version: s.version,
    machine: s.machine ?? "",
    install: s.install,
    registry: s.registry,
    repos: s.repos,
    rows: s.rows,
    trunks: s.trunks,
    themePrefs: s.themePrefs,
    agents: s.agents,
    defaultAgent: s.defaultAgent,
    agentChosen: s.agentChosen,
    home: s.home,
    folderDialog: s.folderDialog,
    keepAwake: s.keepAwake,
    remote: s.remote,
    tailscale: s.tailscale,
    machines: s.handed,
    gitIdentity: s.gitIdentity,
    visits: s.visits,
    managed: s.managed,
  };
}

/** a snapshot this build can read: written by a page speaking the same protocol */
export const recallable = (s: { protocol: number } | null | undefined): boolean => s?.protocol === PROTOCOL_VERSION;

/** the stamps of a page that can vouch for nothing: what a recalled hello carries, since its rows
 * are stilled and not what the daemon sent */
export const NO_STAMPS: Stamps = { rows: "", repos: "", visits: "", themes: "" };

/** The hello the reducer runs on recall: the snapshot with empties for what it left out, and every
 * row made still. An agent that was `working` reads as `idle`: the shimmer, the climbing seconds
 * and the preview tab all key on a live agent or a running server, and a frozen row must never
 * claim either. `waiting` and `error` stay, since they are still true of the row as last seen and
 * are what a phone is opened to find. */
export function recalledHello(s: HelloSnapshot): HelloFull {
  const { at: _at, ...rest } = s;
  return {
    t: "hello",
    ...rest,
    rows: s.rows.map(stilled),
    trunks: Object.fromEntries(Object.entries(s.trunks).map(([id, t]) => [id, stilledTrunk(t)])),
    stamps: NO_STAMPS,
    themes: [],
    drafts: {},
    attachments: {},
    knocks: [],
    letIn: false,
    self: null,
    update: null,
    globalInstall: null,
    pending: [],
  };
}

function stilled(w: WorktreeStatus): WorktreeStatus {
  // a landing op, a queue behind a turn and a login tab are all things in motion
  const { stopping: _s, shipping: _sh, queued: _q, syncQueued: _sq, ...row } = w;
  return { ...row, agent: w.agent === "working" ? "idle" : w.agent, procs: [], login: false };
}

function stilledTrunk(t: TrunkStatus): TrunkStatus {
  const { shipping: _sh, ...rest } = t;
  return rest;
}

/** when the newest event in a tail happened, by the stamps events carry; null when none does.
 * A recalled chat is dated by this and not by when the snapshot was written, so a count that
 * runs from it (how long a row has waited on you) says the truth. */
export function newestTs(events: readonly TranscriptEntry[]): number | null {
  let at: number | null = null;
  for (const { event } of events) {
    const ts = (event as { ts?: unknown }).ts;
    if (typeof ts === "number" && (at === null || ts > at)) at = ts;
  }
  return at;
}

/** the last `kept` of a list */
export function tailOf<T>(events: readonly T[], kept: number): T[] {
  return events.length > kept ? events.slice(events.length - kept) : [...events];
}

/** The ids to evict from a machine's chats: every id no row has any more, then the oldest past the
 * cap among the rest. `at` is when the chat was last written, so the cap keeps what was looked at
 * most recently. */
export function evictions(
  chats: Record<string, { at: number }>,
  rows: readonly { id: string }[],
  kept = CHATS_KEPT,
): string[] {
  const ids = new Set(rows.map((r) => r.id));
  const gone = Object.keys(chats).filter((id) => !ids.has(id));
  const staying = Object.entries(chats)
    .filter(([id]) => ids.has(id))
    .sort((a, b) => b[1].at - a[1].at);
  return [...gone, ...staying.slice(kept).map(([id]) => id)];
}

/**
 * One chat's tail as the frames give it. A whole backfill replaces it and one that follows a
 * `since` adds to it; each live frame is added raw, since the tap sits before the store's own
 * batching and sees every streamed token. The fold runs when the tail is read for a write, and
 * when the raw run has grown past twice the cap, so what is held between writes stays bounded by
 * rows and not by tokens.
 */
export class ChatTail {
  private events: TranscriptEntry[] = [];
  /** the highest raw seq heard; -1 before any frame */
  seq = -1;
  /** The page holds the chat up to `seq` from its first row: a backfill was heard whole. A recalled
   * chat is the kept tail alone, and a subscribe that asked for what came after it would leave the
   * rows above the tail unreachable, so the cursor is offered only when this is true. */
  whole = false;

  /** the transcript as a backfill or a recall gives it; `last` is the raw seq it reaches, which the
   * coalesced entries do not say, and `whole` whether it reaches back to the first row */
  reset(entries: readonly TranscriptEntry[], last: number, whole: boolean) {
    this.events = tailOf(coalesce(entries), CHAT_EVENTS_KEPT);
    this.seq = last;
    this.whole = whole;
  }

  /** the tail a backfill sent past `since`: added, as the daemon's frame says the page holds the rest */
  extend(entries: readonly TranscriptEntry[], last: number) {
    this.events.push(...entries);
    if (last > this.seq) this.seq = last;
    if (this.events.length > CHAT_EVENTS_KEPT * 2) this.events = tailOf(coalesce(this.events), CHAT_EVENTS_KEPT);
  }

  /** the cursor a subscribe sends: the seq, while the page holds everything up to it */
  since(): number | undefined {
    return this.whole && this.seq >= 0 ? this.seq : undefined;
  }

  add(seq: number, event: AgentEvent) {
    this.events.push({ seq, event });
    if (seq > this.seq) this.seq = seq;
    if (this.events.length > CHAT_EVENTS_KEPT * 2) this.events = tailOf(coalesce(this.events), CHAT_EVENTS_KEPT);
  }

  snapshot(draft: string | undefined, at: number): ChatSnapshot {
    this.events = tailOf(coalesce(this.events), CHAT_EVENTS_KEPT);
    return {
      protocol: PROTOCOL_VERSION,
      at,
      events: [...this.events],
      seq: this.seq,
      ...(draft ? { draft } : {}),
    };
  }
}
