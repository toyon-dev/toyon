// The two small questions toyon asks an agent on its own behalf: name a task, split a request into
// tasks. Prompts and answer parsing live here; asking goes through the worktree's own agent
// (AcpSession.ask) or a throwaway one (oneshot.ts), so the daemon carries no vendor SDK.

import type { WorktreeInfo } from "@toyon/shared";
import type { StateStore } from "../core/state.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import { DEFAULT_AGENT_ID } from "../runtime/registry.ts";
import { askFreshAgent } from "./oneshot.ts";
import type { AgentRegistry } from "./registry.ts";

export const NAME_SYSTEM = "You are a naming assistant. Reply with only the requested name.";
export const namePrompt = (task: string) =>
  `Name this coding task in 2 to 4 lowercase kebab-case words (like "sticky-header" or "dark-mode-toggle"). Reply with ONLY the name, nothing else.\n\nTask: ${task.slice(0, 500)}`;

/** 2–4 kebab words or nothing: an error message or a sentence must not become a title */
export function parseName(text: string | null): string | null {
  if (!text) return null;
  const line = text.trim().split("\n").at(-1) ?? "";
  const name = line
    .toLowerCase()
    .replace(/[`"'.]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  const words = name.split("-").filter(Boolean);
  if (words.length < 1 || words.length > 4 || name.length < 3) return null;
  if (/error|fail|sorry|cannot|unable/.test(name)) return null;
  return name;
}

export const PLAN_SYSTEM = "You are a task-planning assistant. Reply with only the requested JSON.";
export const planPrompt = (request: string) =>
  [
    "Split this request into independent coding tasks that could each be done in a separate git branch by a separate engineer.",
    "Reply with ONLY a JSON array of task description strings (1 to 5 items), nothing else.",
    "If the request is really one task, reply with a single-item array.",
    `Request: ${request.slice(0, 2000)}`,
  ].join("\n");

export function parsePlan(text: string | null): string[] | null {
  if (!text) return null;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    const tasks = arr.filter((x) => typeof x === "string" && x.trim()).slice(0, 5);
    return tasks.length > 0 ? tasks : null;
  } catch {
    // the agent wrapped or truncated the array: no plan, the caller falls back to one task
    return null;
  }
}

/** names a task on the worktree's own agent (the adapter it already runs, a side session) */
export function makeNamer(runtime: RuntimeRegistry) {
  return async (task: string, wt: WorktreeInfo): Promise<string | null> =>
    parseName(await runtime.ensureAgent(wt).agent.ask(NAME_SYSTEM, namePrompt(task)));
}

/** plans a batch on the default agent, spawned for the question (no worktree exists yet) */
export function makePlanner(agents: AgentRegistry, state: StateStore) {
  return async (request: string, cwd: string): Promise<string[] | null> =>
    parsePlan(
      await askFreshAgent(agents, state.defaultAgent ?? DEFAULT_AGENT_ID, cwd, PLAN_SYSTEM, planPrompt(request)),
    );
}
