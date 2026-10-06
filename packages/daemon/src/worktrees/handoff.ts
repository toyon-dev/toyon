// A handoff: work that belongs in another project Toyon has open continues there. The agent in a
// worktree proposes it through Toyon's own tool (or the person does, through the verb), a card on
// that chat asks the person, and Go starts a worktree in the other project seeded with the
// message. The card's whole state lives on the origin's transcript: a proposal is open from its
// `handoff-proposed` until a `handoff` or `handoff-declined` with the same id, so it survives a
// daemon restart and a second tab, and the answer is resolved from the transcript rather than from
// a table here.

import { randomUUID } from "node:crypto";
import type { AgentEvent, RepoInfo, WorktreeInfo } from "@toyon/shared";
import { DEFAULT_PERMISSION_MODE, HANDOFF_TOOL } from "@toyon/shared";
import type { McpTool, McpToolResult, ToolProvider } from "../agent/mcp.ts";
import { handoffAskPrompt, handoffPrompt } from "../agent/prompt.ts";
import type { TranscriptEntry } from "../agent/transcript.ts";
import { UserError } from "../core/errors.ts";
import type { Hub } from "../core/hub.ts";
import { log } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import type { RuntimeRegistry } from "../runtime/registry.ts";
import type { CreateOpts } from "./service.ts";

export interface HandoffDeps {
  state: StateStore;
  hub: Hub;
  runtime: Pick<RuntimeRegistry, "agentFor" | "ensureAgent">;
  /** WorktreeService.create, as a closure: the two services must not import each other */
  create: (repoId: string, prompt: string, opts: CreateOpts) => Promise<WorktreeInfo>;
}

type Proposed = Extract<AgentEvent, { type: "handoff-proposed" }>;

/** what the tool and the verb hand in; the caps keep a runaway agent from filling the card */
interface Proposal {
  project: string;
  message: string;
  title?: string;
}

const MESSAGE_MAX = 20_000;
const TITLE_MAX = 200;
const PROJECT_MAX = 200;
/** proposals one turn may make, answered or not: a loop ends here */
const PER_TURN_MAX = 3;

const refused = (text: string): McpToolResult => ({ text, isError: true });

/** the proposals on a transcript nothing has closed, newest last */
function openProposals(entries: readonly TranscriptEntry[]): Proposed[] {
  const open = new Map<string, Proposed>();
  for (const { event } of entries) {
    if (event.type === "handoff-proposed") open.set(event.id, event);
    else if (event.type === "handoff" || event.type === "handoff-declined") open.delete(event.id);
  }
  return [...open.values()];
}

/** how many proposals the turn under way has made, declined ones included */
function proposedThisTurn(entries: readonly TranscriptEntry[]): number {
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!.event;
    if (e.type === "turn-start") break;
    if (e.type === "handoff-proposed") n++;
  }
  return n;
}

export class HandoffService implements ToolProvider {
  /** proposals whose Go is making the worktree now: a second press meanwhile is a no-op */
  private settling = new Set<string>();

  constructor(private d: HandoffDeps) {
    d.hub.on("landed", (worktreeId) => this.landed(worktreeId));
  }

  /** the projects a handoff from this worktree can go to: every open one but its own */
  targets(worktreeId: string): RepoInfo[] {
    const own = this.d.state.worktree(worktreeId)?.repoId;
    return this.d.state.repos.filter((r) => r.id !== own);
  }

  /** The project a name or a path means. Names are the checkout's directory name, so two open
   * projects can share one; a path settles it, and the refusal for an ambiguous name says so. A
   * unique prefix is enough, as it is in the shell's own picker. Never the worktree's own project. */
  resolve(worktreeId: string, project: string): { repo: RepoInfo } | { refused: string } {
    const q = project.trim();
    const others = this.targets(worktreeId);
    if (others.length === 0)
      return { refused: "No other project is open in Toyon, so there is nothing to hand off to." };
    const names = others.map((r) => r.name).join(", ");
    if (!q) return { refused: `Name the project to continue in. Open projects: ${names}.` };
    const found = match(others, q);
    if (found.length === 1) return { repo: found[0]! };
    if (found.length > 1) {
      return {
        refused: `"${q}" names more than one open project: ${found.map((r) => r.path).join(", ")}. Say which by its path.`,
      };
    }
    const wt = this.d.state.worktree(worktreeId);
    const own = wt ? this.d.state.repo(wt.repoId) : undefined;
    if (own && match([own], q).length === 1) {
      return {
        refused: `${own.name} is this worktree's own project; a handoff goes to another one. Open projects: ${names}.`,
      };
    }
    return { refused: `No open project is called "${q}". Open projects: ${names}.` };
  }

  /** the tool as the agent sees it, listed with the projects it can name right now */
  tool(worktreeId: string): McpTool {
    const names = this.targets(worktreeId).map((r) => r.name);
    const open = names.length
      ? `Open projects you can name: ${names.join(", ")}.`
      : "No other project is open right now.";
    return {
      name: HANDOFF_TOOL,
      description: `Propose continuing the current task in another project Toyon has open, when a change belongs there and not in this worktree. Nothing starts: a card with your message appears in this chat and the person decides. ${open}`,
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "The other project's name as listed, or its path." },
          message: {
            type: "string",
            description:
              "What that project's agent starts from: what is needed and why, how to reproduce it, and the paths in this worktree that depend on it. It is sent as that agent's first message.",
          },
          title: { type: "string", description: "A short name for the new worktree, a few words." },
        },
        required: ["project", "message"],
        additionalProperties: false,
      },
    };
  }

  /** a call from the agent, over MCP: the shape is checked here, since the client's own check
   * cannot be relied on, and then it is a proposal like the person's */
  async call(worktreeId: string, args: unknown): Promise<McpToolResult> {
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
    const shaped =
      a &&
      typeof a.project === "string" &&
      typeof a.message === "string" &&
      (a.title === undefined || typeof a.title === "string");
    if (!shaped) return refused("handoff takes { project: string, message: string, title?: string }.");
    return this.propose(
      worktreeId,
      { project: a.project as string, message: a.message as string, ...(a.title ? { title: a.title as string } : {}) },
      "agent",
    );
  }

  /** A proposal onto the chat as a card. One open card per chat, and three proposals per turn
   * however they were answered: the agent is told to finish its turn either way, since the card
   * is the person's and nothing it does next changes that. */
  propose(worktreeId: string, p: Proposal, by: "agent" | "person"): McpToolResult {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) throw new UserError("that chat is gone");
    if (p.project.length > PROJECT_MAX) return refused(`The project name is over ${PROJECT_MAX} characters.`);
    if ((p.title ?? "").length > TITLE_MAX) return refused(`The title is over ${TITLE_MAX} characters; a few words.`);
    if (p.message.length > MESSAGE_MAX) {
      return refused(`The message is over ${MESSAGE_MAX} characters; cut it to what the other agent needs.`);
    }
    const target = this.resolve(worktreeId, p.project);
    if ("refused" in target) return refused(target.refused);
    const message = p.message.trim();
    if (!message) return refused("Write the message the other project's agent should start from.");
    const agent = this.d.runtime.ensureAgent(wt).agent;
    const entries = agent.transcript();
    if (openProposals(entries).length > 0) {
      return refused("A handoff is already waiting for the person on this chat; finish your turn.");
    }
    // the person's own proposals are gated by the open card alone: no turn of theirs to finish
    if (by === "agent" && proposedThisTurn(entries) >= PER_TURN_MAX) {
      return refused("Three handoffs were proposed this turn already; finish your turn and let the person answer.");
    }
    const title = p.title?.trim();
    const { repo } = target;
    agent.note({
      type: "handoff-proposed",
      id: randomUUID(),
      repo: { id: repo.id, name: repo.name, path: repo.path },
      message,
      ...(title ? { title } : {}),
      by,
      mode: wt.mode ?? DEFAULT_PERMISSION_MODE,
      ts: Date.now(),
    });
    return { text: "Proposed to the person as a card; they decide. Finish your turn." };
  }

  /** The person's answer on the card. Go makes the worktree in the other project and records
   * where the work went; Not now closes the card. A card already closed is the other tab's doing
   * and not an error; a Go already under way is left to finish. Whatever stops a Go closes the
   * card as failed on every tab, and the pressing tab reads why. */
  async answer(worktreeId: string, id: string, go: boolean, note?: string): Promise<void> {
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) throw new UserError("that chat is gone");
    const agent = this.d.runtime.ensureAgent(wt).agent;
    const entries = agent.transcript();
    const proposed = entries.find(({ event }) => event.type === "handoff-proposed" && event.id === id)?.event as
      | Proposed
      | undefined;
    if (!proposed) throw new UserError("That card is not in this chat");
    if (!openProposals(entries).some((p) => p.id === id)) {
      return log.debug(worktreeId, `answer for a handoff that already closed (${id})`);
    }
    if (this.settling.has(id)) return;
    if (!go) {
      agent.note({ type: "handoff-declined", id, ts: Date.now() });
      return;
    }
    this.settling.add(id);
    try {
      const repo = this.d.state.repo(proposed.repo.id);
      if (!repo) throw new UserError(`${proposed.repo.name} is no longer open in Toyon`);
      const origin = this.d.state.requireRepo(wt.repoId);
      const added = note?.trim() || undefined;
      const prompt = handoffPrompt(proposed.message, added, { path: wt.path, project: origin.name, branch: wt.branch });
      // no createdBy: the row is nobody's to jump to, and the person stays where they are
      const made = await this.d.create(repo.id, prompt, {
        ...(proposed.title ? { title: proposed.title } : {}),
        mode: proposed.mode,
        from: { kind: "worktree", ref: wt.branch, origin: { id: wt.id, repoId: wt.repoId } },
      });
      agent.note({
        type: "handoff",
        id,
        worktreeId: made.id,
        repoId: repo.id,
        repoName: repo.name,
        title: made.title,
        ts: Date.now(),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      agent.note({ type: "handoff-declined", id, outcome: "failed", reason, ts: Date.now() });
      throw e;
    } finally {
      this.settling.delete(id);
    }
  }

  /** The verb: the person wants the work continued in `repoId`. With the tool in the agent's
   * hands the agent is asked to propose it, so the message is its own account of the work, with
   * the person's words carried; without the tool the card is raised from those words alone. */
  async ask(worktreeId: string, repoId: string, text?: string): Promise<void> {
    const wt = this.d.state.requireWorktree(worktreeId);
    const repo = this.d.state.repo(repoId);
    if (!repo) throw new UserError("no such project");
    if (repo.id === wt.repoId) throw new UserError(`${repo.name} is this worktree's own project`);
    const agent = this.d.runtime.agentFor(worktreeId);
    if (!agent) throw new UserError("worktree still starting; try again in a moment");
    // whether the agent has the tool is only known once its process is up
    if (agent.mcpTools === null) await agent.warm();
    if (agent.mcpTools === true) {
      agent.send(handoffAskPrompt(repo, text), { asked: { kind: "handoff", why: `continue in ${repo.name}` } });
      return;
    }
    const own = text?.trim();
    if (!own) throw new UserError(`Write what ${repo.name} should do first`);
    const r = this.propose(worktreeId, { project: repo.path, message: own }, "person");
    if (r.isError) throw new UserError(r.text);
  }

  /** a worktree landed: when a handoff made it, the worktree it came from is told, on its chat
   * and in its agent's next prompt. Nothing when the origin is gone or was never a worktree. */
  landed(worktreeId: string): void {
    const wt = this.d.state.worktree(worktreeId);
    if (wt?.from?.kind !== "worktree") return;
    const origin = this.d.state.worktree(wt.from.origin.id);
    if (origin?.kind !== "worktree") return;
    const repo = this.d.state.repo(wt.repoId);
    if (!repo) return;
    this.d.runtime.ensureAgent(origin).agent.note({
      type: "handoff-landed",
      worktreeId: wt.id,
      repoName: repo.name,
      title: wt.title,
      ...(wt.pr?.url ? { url: wt.pr.url } : {}),
      ts: Date.now(),
    });
  }
}

/** the repos `q` names: its path, its exact name, its name in any case, then a unique prefix */
function match(repos: readonly RepoInfo[], q: string): RepoInfo[] {
  const lower = q.toLowerCase();
  const ladder: Array<(r: RepoInfo) => boolean> = [
    (r) => r.path === q,
    (r) => r.name === q,
    (r) => r.name.toLowerCase() === lower,
    (r) => r.name.toLowerCase().startsWith(lower),
  ];
  for (const rung of ladder) {
    const found = repos.filter(rung);
    if (found.length > 0) return found;
  }
  return [];
}
