import type { ProcState } from "@toyon/shared";

/** the one footer dot: daemon connection and the active worktree's procs, worst first */
export type HealthLevel = "offline" | "crashed" | "stopped" | "starting" | "ok";

export interface Health {
  level: HealthLevel;
  /** short label for the expanded rail */
  label: string;
  /** tooltip: what is wrong and what a click does */
  tip: string;
  /** procs a click restarts */
  restart: string[];
}

const RANK: Record<HealthLevel, number> = { offline: 0, crashed: 1, stopped: 2, starting: 3, ok: 4 };

export function health(connected: boolean, procs: ProcState[]): Health {
  if (!connected) return { level: "offline", label: "reconnecting…", tip: "Reconnecting to daemon", restart: [] };
  const bad = procs.filter((p) => p.status !== "running");
  if (bad.length === 0) {
    const on = procs.map((p) => `${p.name} :${p.port}`).join(", ");
    return { level: "ok", label: "connected", tip: on ? `Connected · ${on}` : "Connected to daemon", restart: [] };
  }
  const level = bad.map((p) => p.status as HealthLevel).sort((a, b) => RANK[a] - RANK[b])[0] ?? "ok";
  const what = bad.map((p) => `${p.name} ${p.status} on :${p.port}`).join(", ");
  // "starting" resolves on its own; a restart there only makes it start over
  const restart = bad.filter((p) => p.status !== "starting").map((p) => p.name);
  const label = bad.length === 1 ? `${bad[0]?.name} ${bad[0]?.status}` : `${bad.length} procs ${level}`;
  return {
    level,
    label,
    tip: restart.length ? `${what} · click to open its tab` : what,
    restart,
  };
}
