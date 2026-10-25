// The small questions toyon asks an agent on its own behalf: name a task, judge a landing, recap
// a turn. Prompts and answer parsing live here; asking goes through the worktree's own agent
// (AcpSession.ask), so the daemon carries no vendor SDK. Naming prefers the agent's quick model
// and falls back to its default: a worktree still wants a name on an agent that offers no small
// model.

import type { AttachmentInput, WorktreeInfo } from "@toyon/shared";
import type { StateStore } from "../core/state.ts";
import { DEFAULT_AGENT_ID, type RuntimeRegistry } from "../runtime/registry.ts";
import { NAME_SHAPE, overNameShape, sentenceCase } from "../worktrees/naming.ts";
import { ANSWER_SYSTEM, LAND_SYSTEM, type LandVerdict, parseLanding } from "./landing.ts";
import { parseRecap } from "./recap.ts";
import type { AgentRegistry } from "./registry.ts";

export const NAME_SYSTEM = "You are a naming assistant. Reply with only the requested name.";
export const namePrompt = (task: string) =>
  `Name this coding task the way a teammate would say it out loud: 1 or 2 plain lowercase words, 16 characters at most (like "sticky header", "dark mode", "price badge"). Leave out words every task in the project would share, like the product or the app. Reply with ONLY the name, nothing else.\n\nTask: ${task.slice(0, 500)}`;

/** What a task is named from: its message's text, or, when the message was attachments alone,
 * what they carry: a paste's text, an image's or a file's name, a picked element's component or tag and its
 * text. Empty when there is nothing to name from, and then no name is asked for. */
export function taskText(text: string, attachments: readonly AttachmentInput[] = []): string {
  if (text.trim()) return text;
  return attachments.map(attachmentText).join("\n\n");
}

function attachmentText(a: AttachmentInput): string {
  if (a.kind === "paste") return a.text;
  if (a.kind === "image") return a.name ? `image ${a.name}` : "an image";
  if (a.kind === "file") return `file ${a.name}`;
  return `element <${a.component ?? a.tag}>${a.text ? ` "${a.text}"` : ""}`;
}

/** A name in the shape or nothing: an error message or a sentence must not become a title. A name
 * too long for the rail is refused rather than cut, since a cut can turn an error's opening words
 * into a name that passes. The answer comes back kebab-case however the prompt is worded, so a run
 * of punctuation reads as one space and the words are counted from there; the branch carries the
 * slug, and this is the title a person reads. */
export function parseName(text: string | null): string | null {
  if (!text) return null;
  const line = text.trim().split("\n").at(-1) ?? "";
  const name = line
    .toLowerCase()
    .replace(/[`"'.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (name.length < 3 || overNameShape(name)) return null;
  if (/error|fail|sorry|cannot|unable|unauthori|forbidden|denied|\b[45]\d\d\b/.test(name)) return null;
  return sentenceCase(name);
}

/** names a task on the worktree's own agent (the adapter it already runs, a side session) */
export function makeNamer(runtime: RuntimeRegistry) {
  return async (task: string, wt: WorktreeInfo): Promise<string | null> =>
    parseName(await runtime.ensureAgent(wt).agent.ask(NAME_SYSTEM, namePrompt(task), { quick: "prefer" }));
}

/** Whether what is already known of the agent rules its quick model out, so a question that requires
 * one is not worth waking the agent for. A fixed id is checked against the models the agent last
 * listed. An agent that picks from its list (a function) decides on the session, where the current
 * model is known. */
export function lacksQuickModel(
  spec: NonNullable<ReturnType<AgentRegistry["get"]>>,
  state: Pick<StateStore, "cachedOptions">,
): boolean {
  const quick = spec.quickModel;
  if (!quick) return true;
  if (typeof quick === "function") return false;
  const offered = state.cachedOptions(spec.id, "model");
  return offered.length > 0 && !offered.some((m) => m.id === quick);
}

/** The pieces of a plan, read off its text when the agent handed none over: a JSON list of the
 * sections the plan itself marks as a separate branch, a sibling worktree or a follow-up. The
 * section is named by its heading so the piece's plan can be cut from the plan verbatim where it stands
 * alone, and the model writes one where it does not; `after` is only
 * "this" (waits for this branch to land) or a branch that exists, since a sibling not yet made has
 * no branch to name. */
export const PIECES_SYSTEM = "You read plans and reply with only the requested JSON.";
export const piecesPrompt = (markdown: string) =>
  [
    "Below is a plan. List the parts of it the plan itself means to build apart from the rest: a step or section it marks as its own branch, a sibling worktree, a follow-up, or independent work. Also list the part it keeps in this worktree, if it says so.",
    `Reply with ONLY a JSON array of 0 to 6 objects, each {"title": a name for the part, ${NAME_SHAPE}, "section": the exact heading text of that part, "plan": the plan for that part's agent in markdown, from the plan's own words: what to build, why, the files, and what done looks like, 150 to 500 words, "where": "worktree" or "here", "after": optional, "this" when the plan says the part waits for this branch to land}.`,
    "Reply with an empty array when the plan is one piece of work with no part set apart.",
    `Plan:\n${markdown.slice(0, 12_000)}`,
  ].join("\n");

export interface ReadPiece {
  title: string;
  section: string;
  /** the plan for the part's agent, in the model's words off the plan: what a sibling is born
   * with when the section it names is shared with another part or missing */
  plan?: string;
  where: "here" | "worktree";
  after?: string;
}

export function parsePieces(text: string | null): ReadPiece[] | null {
  if (!text) return null;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    const out: ReadPiece[] = [];
    for (const x of arr) {
      if (!x || typeof x !== "object") continue;
      const { title, section, plan, where, after } = x as Record<string, unknown>;
      if (typeof title !== "string" || !title.trim() || typeof section !== "string" || !section.trim()) continue;
      if (where !== "here" && where !== "worktree") continue;
      out.push({
        title: title.trim(),
        section: section.trim(),
        ...(typeof plan === "string" && plan.trim() ? { plan: plan.trim() } : {}),
        where,
        ...(typeof after === "string" && after.trim() ? { after: after.trim() } : {}),
      });
    }
    return out.slice(0, 6);
  } catch {
    // the model wrapped or truncated the array: no list, the plan stays whole
    return null;
  }
}

/** reads a plan's pieces on the worktree's own agent's quick model; null where there is none */
export function makePiecesReader(...deps: Parameters<typeof makeQuickAsker>) {
  const ask = makeQuickAsker(...deps);
  return async (wt: WorktreeInfo, markdown: string): Promise<ReadPiece[] | null> =>
    parsePieces(await ask(wt, PIECES_SYSTEM, piecesPrompt(markdown)));
}

/** A question on the worktree's own agent, its quick model or nothing: the side questions that
 * would rather go unasked than cost what the chat costs. It never starts a runtime, and never
 * wakes an agent whose model list is already known to lack its quick model. */
function makeQuickAsker(
  runtime: Pick<RuntimeRegistry, "agentFor">,
  agents: Pick<AgentRegistry, "get">,
  state: Pick<StateStore, "cachedOptions" | "defaultAgent">,
) {
  return async (wt: WorktreeInfo, system: string, prompt: string): Promise<string | null> => {
    const spec = agents.get(wt.agent ?? state.defaultAgent ?? DEFAULT_AGENT_ID);
    if (!spec || lacksQuickModel(spec, state)) return null;
    const agent = runtime.agentFor(wt.id);
    return agent ? agent.ask(system, prompt, { quick: "require" }) : null;
  };
}

/** The landing verdict, the recap sentence and the commit message, after a finished turn with
 * work on it. Without a quick model, readiness rests on the check alone and the recap is facts. */
export function makeLander(...deps: Parameters<typeof makeQuickAsker>) {
  const ask = makeQuickAsker(...deps);
  return async (wt: WorktreeInfo, prompt: string): Promise<LandVerdict | null> =>
    parseLanding(await ask(wt, LAND_SYSTEM, prompt));
}

/** The recap sentence alone, after a finished turn that left nothing to land: an answer, a review,
 * an explanation. Without a quick model the line is the facts, as for the landing question. */
export function makeAnswerRecapper(...deps: Parameters<typeof makeQuickAsker>) {
  const ask = makeQuickAsker(...deps);
  return async (wt: WorktreeInfo, prompt: string): Promise<string | null> =>
    parseRecap(await ask(wt, ANSWER_SYSTEM, prompt));
}
