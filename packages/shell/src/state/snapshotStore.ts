// Where the last-known machine is kept: one IndexedDB database with one object store, keyed by
// machine origin (keys.ts). Rows are about 100 KB per machine and a chat's tail can be hundreds of
// kilobytes, which is past what localStorage holds for a whole origin. Every call swallows its
// own failure the way the localStorage guards do: a private window, a full quota or a browser
// with no IndexedDB leaves the page working and only the memory lost.

import { SNAPSHOT_DB, SNAPSHOT_STORE, snapshotKey } from "./keys.ts";
import type { ChatSnapshot, HelloSnapshot } from "./snapshot.ts";

export interface SnapshotStore {
  hello(origin: string): Promise<HelloSnapshot | null>;
  putHello(origin: string, s: HelloSnapshot): Promise<void>;
  /** every chat kept for the machine, by worktree id */
  chats(origin: string): Promise<Record<string, ChatSnapshot>>;
  putChat(origin: string, id: string, c: ChatSnapshot): Promise<void>;
  dropChats(origin: string, ids: readonly string[]): Promise<void>;
  /** every key under this origin, gone: for a machine being forgotten (machines.ts `remove`) */
  clear(origin: string): Promise<void>;
}

/** a store over a Map: for tests, and for a browser with no IndexedDB */
export function memoryStore(): SnapshotStore {
  const m = new Map<string, unknown>();
  const chatsOf = (origin: string) => {
    const prefix = snapshotKey.chats(origin);
    const out: Record<string, ChatSnapshot> = {};
    for (const [k, v] of m) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v as ChatSnapshot;
    return out;
  };
  return {
    hello: async (origin) => (m.get(snapshotKey.hello(origin)) as HelloSnapshot | undefined) ?? null,
    putHello: async (origin, s) => void m.set(snapshotKey.hello(origin), s),
    chats: async (origin) => chatsOf(origin),
    putChat: async (origin, id, c) => void m.set(snapshotKey.chat(origin, id), c),
    dropChats: async (origin, ids) => {
      for (const id of ids) m.delete(snapshotKey.chat(origin, id));
    },
    clear: async (origin) => {
      m.delete(snapshotKey.hello(origin));
      for (const k of [...m.keys()]) if (k.startsWith(snapshotKey.chats(origin))) m.delete(k);
    },
  };
}

/** the browser's store; a Map when the browser has none */
export function idbStore(): SnapshotStore {
  if (typeof indexedDB === "undefined") return memoryStore();
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => {
    // an open that failed is tried again on the next call: storage under pressure at boot is not
    // storage gone for the page's life
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(SNAPSHOT_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(SNAPSHOT_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    }).catch((e) => {
      opened = null;
      throw e;
    });
    return opened;
  };
  /** one request in a transaction of its own, as a promise; the failure is the caller's to swallow */
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const store = (await db()).transaction(SNAPSHOT_STORE, mode).objectStore(SNAPSHOT_STORE);
    return new Promise<T>((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  /** the keys of every chat under an origin: the prefix ends in a slash, so an origin that is a
   * prefix of another (a host, and the host with a port) never reads the other's chats */
  const chatRange = (origin: string) => {
    const prefix = snapshotKey.chats(origin);
    return IDBKeyRange.bound(prefix, `${prefix}￿`);
  };
  const quiet = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      // storage blocked, full or gone: the page still works, only the memory is lost
      return fallback;
    }
  };
  return {
    hello: (origin) =>
      quiet(
        run<HelloSnapshot | undefined>("readonly", (s) => s.get(snapshotKey.hello(origin))),
        undefined,
      ).then((v) => v ?? null),
    putHello: (origin, snap) =>
      quiet(
        run("readwrite", (s) => s.put(snap, snapshotKey.hello(origin))),
        undefined,
      ).then(() => undefined),
    chats: async (origin) => {
      const prefix = snapshotKey.chats(origin);
      // keys and values in one transaction, so another tab's write between them cannot pair a
      // chat's id with the next chat's transcript
      const [keys, values] = await quiet(
        (async () => {
          const store = (await db()).transaction(SNAPSHOT_STORE, "readonly").objectStore(SNAPSHOT_STORE);
          const ask = <T>(req: IDBRequest<T>) =>
            new Promise<T>((resolve, reject) => {
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => reject(req.error);
            });
          return Promise.all([ask(store.getAllKeys(chatRange(origin))), ask(store.getAll(chatRange(origin)))]);
        })(),
        [[], []] as [IDBValidKey[], ChatSnapshot[]],
      );
      const out: Record<string, ChatSnapshot> = {};
      keys.forEach((k, i) => {
        const v = values[i];
        if (typeof k === "string" && v) out[k.slice(prefix.length)] = v;
      });
      return out;
    },
    putChat: (origin, id, c) =>
      quiet(
        run("readwrite", (s) => s.put(c, snapshotKey.chat(origin, id))),
        undefined,
      ).then(() => undefined),
    dropChats: async (origin, ids) => {
      for (const id of ids)
        await quiet(
          run("readwrite", (s) => s.delete(snapshotKey.chat(origin, id))),
          undefined,
        );
    },
    clear: async (origin) => {
      await quiet(
        run("readwrite", (s) => s.delete(snapshotKey.hello(origin))),
        undefined,
      );
      await quiet(
        run("readwrite", (s) => s.delete(chatRange(origin))),
        undefined,
      );
    },
  };
}
