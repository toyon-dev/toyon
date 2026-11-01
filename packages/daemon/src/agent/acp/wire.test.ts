import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_AGENTS } from "../registry.ts";
import { type AdapterWire, flagsOf, PROTOCOL, WIRES, wireFlags } from "./wire.ts";

describe("wire", () => {
  test("each builtin's rows were read against the version registry.ts pins", () => {
    for (const a of BUILTIN_AGENTS) {
      const wire = WIRES[a.id];
      expect(wire, `${a.id} has no rows`).toBeDefined();
      // a bump lands here first: read every row of the agent against the new dist, flip the ones
      // the release closed, then move `at`
      expect(wire?.at, a.id).toBe(a.run.kind === "command" ? "" : a.run.version);
    }
  });

  test("the protocol rows were read against the SDK the daemon speaks", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(PROTOCOL.at).toBe(pkg.dependencies["@agentclientprotocol/sdk"] ?? "");
  });

  test("every row says what the wire lacks, what toyon does about it and where the fix stands", () => {
    for (const [id, wire] of Object.entries({ ...WIRES, protocol: PROTOCOL })) {
      expect(Object.keys(wire.gaps).length, id).toBeGreaterThan(0);
      for (const [key, row] of Object.entries(wire.gaps)) {
        for (const field of ["gap", "here", "upstream"] as const) {
          expect(row[field].trim().length, `${id}.${key}.${field}`).toBeGreaterThan(12);
        }
      }
    }
  });

  test("an agent with no rows is assumed to send none of it", () => {
    expect(wireFlags("someone-else")).toEqual({
      noStartSignal: true,
      cutCallUnreported: true,
      backgroundFinish: true,
      modelIdOffList: true,
    });
  });

  test("a row flipped closed stands its site down; a row the table lacks keeps the fallback", () => {
    const wire: AdapterWire = {
      at: "x",
      gaps: { noStartSignal: { gap: "none", here: "nothing", upstream: "shipped", open: false } },
    };
    const flags = flagsOf(wire);
    expect(flags.noStartSignal).toBe(false);
    expect(flags.cutCallUnreported).toBe(true);
    expect(flags.backgroundFinish).toBe(true);
  });
});
