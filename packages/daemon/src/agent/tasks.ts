// The small questions toyon asks an agent on its own behalf: name a task, split a request into
// tasks. Prompts and answer parsing live here; asking goes through the worktree's own agent
// (AcpSession.ask) or a throwaway one (oneshot.ts), so the daemon carries no vendor SDK. Both
// prefer the agent's quick model and fall back to its default: a worktree still wants a name, and a
// batch still wants splitting, on an agent that offers no small model.

import type { AttachmentInput, WorktreeInfo } from "@toyon/shared";
import type { StateStore } from "../core/state.ts";
import { DEFAULT_AGENT_ID, type RuntimeRegistry } from "../runtime/registry.ts";
import { LAND_SYSTEM, type LandVerdict, parseLanding } from "./landing.ts";
import { askFreshAgent } from "./oneshot.ts";
import { parseRecap, RECAP_SYSTEM } from "./recap.ts";
import type { AgentRegistry } from "./registry.ts";

export const NAME_SYSTEM = "You are a naming assistant. Reply with only the requested name.";
export const namePrompt = (task: string) =>
  `Name this coding task the way a teammate would say it out loud: 1 or 2 lowercase kebab-case words, 16 characters at most (like "sticky-header", "dark-mode", "price-badge"). Leave out words every task in the project would share, like the product or the app. Reply with ONLY the name, nothing else.\n\nTask: ${task.slice(0, 500)}`;

/** What a task is named from: its message's text, or, when the message was attachments alone,
 * what they carry: a paste's text, an image's name, a picked element's component or tag and its
 * text. Empty when there is nothing to name from, and then no name is asked for. */
export function taskText(text: string, attachments: readonly AttachmentInput[] = []): string {
  if (text.trim()) return text;
  return attachments.map(attachmentText).join("\n\n");
}

function attachmentText(a: AttachmentInput): string {
  if (a.kind === "paste") return a.text;
  if (a.kind === "image") return a.name ? `image ${a.name}` : "an image";
  return `element <${a.component ?? a.tag}>${a.text ? ` "${a.text}"` : ""}`;
}

/** 1-3 kebab words or nothing: an error message or a sentence must not become a title. A name
 * too long for the rail is refused rather than cut, since a cut can turn an error's opening
 * words into a name that passes. */
export function parseName(text: string | null): string | null {
  if (!text) return null;
  const line = text.trim().split("\n").at(-1) ?? "";
  const name = line
    .toLowerCase()
    .replace(/[`"'.]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const words = name.split("-").filter(Boolean);
  if (words.length < 1 || words.length > 3 || name.length < 3 || name.length > 20) return null;
  if (/error|fail|sorry|cannot|unable|unauthori|forbidden|denied|\b[45]\d\d\b/.test(name)) return null;
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
    parseName(await runtime.ensureAgent(wt).agent.ask(NAME_SYSTEM, namePrompt(task), { quick: "prefer" }));
}

/** A recap's sentence on the worktree's own agent, on its quick model or not at all: the one side
 * question that would rather go unasked than cost what the chat costs. It never starts a runtime,
 * and never wakes an agent whose model list is already known to lack its quick model. */
export function makeRecapper(
  runtime: Pick<RuntimeRegistry, "agentFor">,
  agents: Pick<AgentRegistry, "get">,
  state: Pick<StateStore, "cachedOptions" | "defaultAgent">,
) {
  return async (wt: WorktreeInfo, prompt: string): Promise<string | null> => {
    const spec = agents.get(wt.agent ?? state.defaultAgent ?? DEFAULT_AGENT_ID);
    if (!spec || lacksQuickModel(spec, state)) return null;
    const agent = runtime.agentFor(wt.id);
    return agent ? parseRecap(await agent.ask(RECAP_SYSTEM, prompt, { quick: "require" })) : null;
  };
}

/** Whether what is already known of the agent rules its quick model out, so a question that requires
 * one is not worth waking the agent for. A fixed id is checked against the models the agent last
 * listed. An agent that picks from its list (a function) decides on the session, where the current
 * model is known. */
function lacksQuickModel(
  spec: NonNullable<ReturnType<AgentRegistry["get"]>>,
  state: Pick<StateStore, "cachedOptions">,
): boolean {
  const quick = spec.quickModel;
  if (!quick) return true;
  if (typeof quick === "function") return false;
  const offered = state.cachedOptions(spec.id, "model");
  return offered.length > 0 && !offered.some((m) => m.id === quick);
}

/** The landing verdict and commit message, on the same terms as the recap: the worktree's own
 * agent, its quick model or nothing. Without one, readiness rests on the check alone. */
export function makeLander(
  runtime: Pick<RuntimeRegistry, "agentFor">,
  agents: Pick<AgentRegistry, "get">,
  state: Pick<StateStore, "cachedOptions" | "defaultAgent">,
) {
  return async (wt: WorktreeInfo, prompt: string): Promise<LandVerdict | null> => {
    const spec = agents.get(wt.agent ?? state.defaultAgent ?? DEFAULT_AGENT_ID);
    if (!spec || lacksQuickModel(spec, state)) return null;
    const agent = runtime.agentFor(wt.id);
    return agent ? parseLanding(await agent.ask(LAND_SYSTEM, prompt, { quick: "require" })) : null;
  };
}

/** plans a batch on the agent the batch will run, spawned for the question (no worktree exists yet) */
export function makePlanner(agents: AgentRegistry) {
  return async (request: string, cwd: string, agentId: string): Promise<string[] | null> =>
    parsePlan(await askFreshAgent(agents, agentId, cwd, PLAN_SYSTEM, planPrompt(request), { quick: "prefer" }));
}
