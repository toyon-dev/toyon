import { describe, expect, test } from "bun:test";
import { type KeyStore, MACHINE_KEYS, migrateStorage, STORAGE, scopedKey, storageFor, WINDOW_KEYS } from "./keys.ts";

/** localStorage's shape over a Map */
function fakeStore(init: Record<string, string> = {}): KeyStore & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    dump: () => Object.fromEntries(m),
  };
}

const HOME = "https://home.tail1234.ts.net";

describe("storage scoped to a machine", () => {
  test("every key is one key and one scope apart: window keys and machine keys never overlap", () => {
    expect(WINDOW_KEYS.filter((k) => MACHINE_KEYS.includes(k))).toEqual([]);
    const named = Object.values(STORAGE);
    for (const k of [...WINDOW_KEYS, ...MACHINE_KEYS]) expect(named).toContain(k);
    expect(new Set([...WINDOW_KEYS, ...MACHINE_KEYS]).size).toBe(named.length);
  });

  test("reads and writes land under the origin, and clear takes that scope alone", () => {
    const local = fakeStore({ "toyon-theme": "t", [scopedKey("toyon-active", "https://work")]: "w1" });
    const session = fakeStore();
    const home = storageFor(HOME, local, session);
    home.set(STORAGE.active, "h1");
    home.session.set(STORAGE.phoneRow, "1");
    expect(home.get(STORAGE.active)).toBe("h1");
    expect(home.session.get(STORAGE.phoneRow)).toBe("1");
    expect(local.getItem(`toyon-active@${HOME}`)).toBe("h1");
    expect(storageFor("https://work", local, session).get(STORAGE.active)).toBe("w1");
    home.clear();
    expect(local.dump()).toEqual({ "toyon-theme": "t", "toyon-active@https://work": "w1" });
    expect(session.length).toBe(0);
  });

  test("a storage that throws reads as empty and swallows writes", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      key: () => null,
      length: 0,
    } satisfies KeyStore;
    const s = storageFor(HOME, broken, broken);
    expect(s.get(STORAGE.active)).toBeNull();
    expect(() => s.set(STORAGE.active, "x")).not.toThrow();
    expect(() => s.clear()).not.toThrow();
  });
});

describe("migrateStorage", () => {
  test("bare machine keys move once under the serving scope, prefix keys by scan, window keys stay", () => {
    const local = fakeStore({
      "toyon-active": "a1",
      "toyon-repo": "r1",
      "toyon-profile-r1": "web",
      "toyon-model-claude": "opus",
      "toyon-theme": "dark",
      "toyon-token": "secret",
      "toyon-layouts": "{}",
    });
    const session = fakeStore({ "toyon-phone-row": "1", "toyon-client": "c1" });
    migrateStorage(HOME, local, session);
    expect(local.dump()).toEqual({
      [`toyon-active@${HOME}`]: "a1",
      [`toyon-repo@${HOME}`]: "r1",
      [`toyon-profile-r1@${HOME}`]: "web",
      [`toyon-model-claude@${HOME}`]: "opus",
      "toyon-theme": "dark",
      "toyon-token": "secret",
      "toyon-layouts": "{}",
    });
    expect(session.dump()).toEqual({ [`toyon-phone-row@${HOME}`]: "1", "toyon-client": "c1" });
  });

  test("idempotent, and a value already in place is not overwritten", () => {
    const local = fakeStore({ "toyon-active": "old", [`toyon-active@${HOME}`]: "new" });
    migrateStorage(HOME, local, fakeStore());
    migrateStorage(HOME, local, fakeStore());
    expect(local.dump()).toEqual({ [`toyon-active@${HOME}`]: "new" });
  });

  test("the pre-rename prefix still migrates first, so an old token lands as the window's", () => {
    const local = fakeStore({ "orch-token": "t0", "orch-active": "a0" });
    migrateStorage(HOME, local, fakeStore());
    expect(local.dump()).toEqual({ "toyon-token": "t0", [`toyon-active@${HOME}`]: "a0" });
  });
});
