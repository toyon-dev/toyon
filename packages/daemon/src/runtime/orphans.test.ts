import { describe, expect, test } from "bun:test";
import type { PsRow } from "./memory.ts";
import { orphansIn, strayAdapters } from "./orphans.ts";

const now = 1_700_000_000_000;
const row = (pid: number, pgid: number, ppid: number, startedAt: number, command = "node vite"): PsRow => ({
  pid,
  pgid,
  ppid,
  startedAt,
  command,
});
const entry = (pgid: number, startedAt = now - 60_000, name = "web", worktreeId = "w1") => ({
  worktreeId,
  pgid,
  name,
  startedAt,
});

describe("orphansIn", () => {
  test("a group whose leader is gone but whose members remain is reclaimed", () => {
    // the shape a dead daemon leaves: the sh that led the proc is gone, vite and esbuild sit under launchd
    const rows = [row(65510, 65506, 1, now - 60_000), row(65520, 65506, 65510, now - 59_000, "esbuild")];
    expect(orphansIn([entry(65506)], rows, "b1", "b1", now)).toEqual([{ worktreeId: "w1", pgid: 65506, name: "web" }]);
  });

  test("a leader started long after the record is pid reuse and is left alone", () => {
    const rows = [row(500, 500, 1, now - 5_000, "unrelated")];
    expect(orphansIn([entry(500, now - 3_600_000)], rows, "b1", "b1", now)).toEqual([]);
  });

  test("a leader within ten seconds of the record is reclaimed with its members", () => {
    const rows = [row(500, 500, 1, now - 63_000), row(501, 500, 500, now - 62_000)];
    expect(orphansIn([entry(500, now - 60_000, "agent:claude")], rows, "b1", "b1", now)).toEqual([
      { worktreeId: "w1", pgid: 500, name: "agent:claude" },
    ]);
  });

  test("a group with nothing in the table is gone, not reclaimed", () => {
    expect(orphansIn([entry(500)], [row(9, 9, 1, now)], "b1", "b1", now)).toEqual([]);
  });

  test("a different boot id drops the ledger and kills nothing", () => {
    const rows = [row(501, 500, 1, now - 60_000)];
    expect(orphansIn([entry(500)], rows, "b2", "b1", now)).toEqual([]);
    expect(orphansIn([entry(500)], rows, "b1", undefined, now)).toEqual([]);
    expect(orphansIn([entry(500)], rows, null, "b1", now)).toEqual([]);
  });

  test("an entry past the day is dropped", () => {
    const rows = [row(501, 500, 1, now - 60_000)];
    expect(orphansIn([entry(500, now - 25 * 3_600_000)], rows, "b1", "b1", now)).toEqual([]);
  });
});

describe("strayAdapters", () => {
  const agentsDir = "/home/me/.toyon/agents";
  test("a reparented adapter under the agents directory is reclaimed, one under a live daemon is not", () => {
    const stray = row(700, 700, 1, now, `node ${agentsDir}/claude/dist/index.js`);
    const owned = row(701, 701, 4321, now, `node ${agentsDir}/codex/dist/index.js`);
    const other = row(702, 702, 1, now, "node /usr/local/lib/node_modules/vite/bin/vite.js");
    const member = row(703, 700, 700, 1, `node ${agentsDir}/claude/cli.js`);
    expect(strayAdapters([stray, owned, other, member], agentsDir)).toEqual([stray]);
  });
});
