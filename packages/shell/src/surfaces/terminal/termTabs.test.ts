import { describe, expect, test } from "bun:test";
import type { ProcState } from "@toyon/shared";
import { borrowedTip, streamTabs } from "./termTabs.ts";

const proc = (name: string): ProcState => ({ name, command: "x", port: 1, status: "running" });

describe("streamTabs", () => {
  test("the worktree's own procs first, then what it borrows, then what it points away", () => {
    const tabs = streamTabs({
      procs: [proc("web")],
      borrowed: [{ name: "api", status: "running" }],
      pointed: { worker: "stage" },
      dirty: 0,
    });
    expect(tabs.map((t) => [t.kind, t.kind === "proc" ? t.proc.name : t.name])).toEqual([
      ["proc", "web"],
      ["borrowed", "api"],
      ["pointed", "worker"],
    ]);
    const pointed = tabs[2];
    expect(pointed?.kind === "pointed" && pointed.tip).toBe("worker points at stage for this worktree");
  });

  test("a borrowed proc up on main wears the ring dot; one down there wears main's status, and the tip says so", () => {
    const [up, cold, crashed] = streamTabs({
      procs: [],
      borrowed: [
        { name: "api", status: "running" },
        { name: "db", status: "cold" },
        { name: "worker", status: "crashed" },
      ],
      pointed: {},
      dirty: 0,
    });
    expect(up?.kind === "borrowed" && up.dot).toBe("borrowed");
    expect(cold?.kind === "borrowed" && cold.dot).toBe("borrowed");
    expect(crashed?.kind === "borrowed" && crashed.dot).toBe("crashed");
    expect(crashed?.kind === "borrowed" && crashed.tip).toBe(
      "worker runs on main for every worktree; this one reaches it at its usual address. Main's worker is crashed.",
    );
  });

  test("a borrowed tab says when main is dirty", () => {
    expect(borrowedTip({ name: "api", status: "running" }, 2)).toBe(
      "api runs on main for every worktree; this one reaches it at its usual address. Main has 2 uncommitted files; api runs on them too.",
    );
    expect(borrowedTip({ name: "api", status: "running" }, 0)).toBe(
      "api runs on main for every worktree; this one reaches it at its usual address.",
    );
  });
});
