// Keeping the last-known machine, and reading it back. One of these rides each machine's store
// (machine.ts): it writes the hello's facts whenever they move and a chat's tail as its frames
// arrive, a couple of seconds behind so a streamed reply is one write and not hundreds, and flushes
// at once when the page goes dark, since a phone in a pocket is the reader this exists for. On
// boot it reads what the last page left and lays it in before any daemon has answered; a hello
// that comes first wins, a snapshot from another protocol is left where it is, and one this build
// cannot lay in is dropped, since the page must paint whatever was kept.

import type { ServerMsg } from "@toyon/shared";
import type { Store } from "./context.tsx";
import { type ChatSnapshot, ChatTail, evictions, recallable, snapshotOf } from "./snapshot.ts";
import type { SnapshotStore } from "./snapshotStore.ts";

/** how long a write waits for the next change: `worktrees` frames arrive once a tick and a reply
 * streams a token at a time, and neither is worth a write of its own */
export const KEEP_QUIET_MS = 2000;

/** how long the first paint waits for the database: a read is milliseconds, and a browser whose
 * open never answers (storage under pressure) must not hold a blank page */
export const RECALL_WAIT_MS = 1500;

export interface Keeper {
  /** the last-known machine laid in, or nothing to lay in; the first paint waits for this, and it
   * never rejects */
  recalled: Promise<void>;
  /** Every frame off the socket, before the store's own batching: the chat tails read the raw
   * ones. Answers the frame as the store should read it: a backfill tail that follows a `since`
   * other than the one this page holds is handed on without its `after`, so the store replaces
   * its chat as the tails here do, and the two never disagree on what the page holds. */
  hear<M extends ServerMsg>(msg: M): M;
  /** the highest raw seq this page holds of a chat, for the subscribe's `since`; undefined when
   * it holds nothing of it, or only a recalled tail with rows above it still to be heard */
  since(id: string): number | undefined;
  /** what this browser keeps of the machine, gone: for a machine being forgotten */
  forget(): void;
  dispose(): void;
}

export interface KeeperDeps {
  timers?: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };
  win?: Pick<Window, "addEventListener" | "removeEventListener"> & { document?: { visibilityState: string } };
  now?: () => number;
}

export function keepSnapshots(store: Store, snapshots: SnapshotStore, origin: string, deps: KeeperDeps = {}): Keeper {
  const timers = deps.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const now = deps.now ?? (() => Date.now());
  const win = deps.win ?? (typeof window === "undefined" ? null : window);

  const tails = new Map<string, ChatTail>();
  const tailOf = (id: string) => {
    let t = tails.get(id);
    if (!t) {
      t = new ChatTail();
      tails.set(id, t);
    }
    return t;
  };
  // when each kept chat was last written, as this page knows it: what eviction reads, so a hello
  // write never reads every transcript back for twenty numbers
  const known = new Map<string, number>();

  // one wait per key: the hello under "", each chat under its id
  const waiting = new Map<string, unknown>();
  const flush = (key: string) => {
    timers.clear(waiting.get(key));
    waiting.delete(key);
    const s = store.getState();
    if (key === "") {
      if (!s.heard) return;
      const snap = snapshotOf(s, now());
      if (!snap) return;
      const gone = evictions(Object.fromEntries([...known].map(([id, at]) => [id, { at }])), s.rows);
      for (const id of gone) {
        known.delete(id);
        tails.delete(id);
      }
      void snapshots.putHello(origin, snap).then(() => (gone.length ? snapshots.dropChats(origin, gone) : undefined));
      return;
    }
    const tail = tails.get(key);
    if (!tail || !s.rows.some((w) => w.id === key)) return;
    const at = now();
    known.set(key, at);
    void snapshots.putChat(origin, key, tail.snapshot(s.local[key]?.draft, at));
  };
  const soon = (key: string) => {
    if (waiting.has(key)) return;
    waiting.set(
      key,
      timers.set(() => flush(key), KEEP_QUIET_MS),
    );
  };
  const flushAll = () => {
    for (const key of [...waiting.keys()]) flush(key);
  };

  // the hello's facts, watched by identity: the reducer makes a new array for every frame that
  // changes one, and the same one otherwise. A draft is watched for every chat with a tail, heard
  // or recalled: what is typed on a page that cannot reach its daemon is the draft most worth
  // keeping.
  let last = store.getState();
  const drafts = new Map<string, string>();
  const unsubscribe = store.subscribe(() => {
    const s = store.getState();
    if (
      s.heard &&
      (!last.heard ||
        s.rows !== last.rows ||
        s.repos !== last.repos ||
        s.trunks !== last.trunks ||
        s.handed !== last.handed ||
        s.visits !== last.visits)
    ) {
      soon("");
    }
    if (s.local !== last.local) {
      for (const id of tails.keys()) {
        const draft = s.local[id]?.draft ?? "";
        if ((drafts.get(id) ?? "") !== draft) {
          drafts.set(id, draft);
          soon(id);
        }
      }
    }
    last = s;
  });

  const hidden = () => {
    if (win?.document?.visibilityState === "hidden") flushAll();
  };
  win?.addEventListener("visibilitychange", hidden);
  win?.addEventListener("pagehide", flushAll);

  const read = Promise.all([snapshots.hello(origin), snapshots.chats(origin)]);
  let wait: unknown;
  const patience = new Promise<null>((resolve) => {
    wait = timers.set(() => resolve(null), RECALL_WAIT_MS);
  });
  const recalled = Promise.race([read, patience])
    .then((got) => {
      timers.clear(wait);
      if (!got) return;
      const [hello, chats] = got;
      for (const [id, c] of Object.entries(chats)) known.set(id, c.at);
      if (!hello || !recallable(hello) || store.getState().heard) return;
      const kept: Record<string, ChatSnapshot> = {};
      for (const [id, c] of Object.entries(chats)) if (recallable(c)) kept[id] = c;
      try {
        store.dispatch({ a: "recall", hello, chats: kept });
      } catch (e) {
        // a record this build cannot lay in: dropped, so the next load starts clean
        console.error("the last-known machine could not be recalled; dropping it", e);
        known.clear();
        void snapshots.clear(origin);
        return;
      }
      // the recalled chats are this page's tails from here: a draft typed on them is written
      // against them, and a backfill replaces them
      for (const [id, c] of Object.entries(kept)) {
        tailOf(id).reset(c.events, c.seq, false);
        drafts.set(id, c.draft ?? "");
      }
    })
    .catch((e) => {
      // storage that cannot be read is a page that starts as a fresh one would
      console.error("the last-known machine could not be read", e);
    });

  return {
    recalled,
    hear<M extends ServerMsg>(msg: M): M {
      if (msg.t === "backfill") {
        const tail = tailOf(msg.worktreeId);
        soon(msg.worktreeId);
        // the store's chat is the other half of what the page holds: a row the daemon dropped and
        // listed again between the subscribe and this frame lost it there, and a tail folded onto
        // nothing would stand as the whole chat with the rows above it never asked for again
        const held = (store.getState().local[msg.worktreeId]?.chat.length ?? 0) > 0;
        if (msg.after !== undefined && msg.after === tail.since() && held) {
          tail.extend(msg.events, msg.last);
          return msg;
        }
        // the whole transcript; or a tail past a `since` this page did not send, or cannot add to,
        // taken as the daemon's word on what is there, with the rows above it still to be heard on
        // the next subscribe
        tail.reset(msg.events, msg.last, msg.after === undefined);
        if (msg.after === undefined) return msg;
        const { after: _a, ...whole } = msg;
        return whole as M;
      }
      if (msg.t === "agent") {
        tailOf(msg.worktreeId).add(msg.seq, msg.event);
        soon(msg.worktreeId);
      }
      return msg;
    },
    since: (id) => tails.get(id)?.since(),
    forget() {
      for (const key of [...waiting.keys()]) {
        timers.clear(waiting.get(key));
        waiting.delete(key);
      }
      tails.clear();
      known.clear();
      void snapshots.clear(origin);
    },
    dispose() {
      unsubscribe();
      win?.removeEventListener("visibilitychange", hidden);
      win?.removeEventListener("pagehide", flushAll);
      flushAll();
    },
  };
}
