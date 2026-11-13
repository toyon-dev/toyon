// The `stop` tool: an agent stops the turn of a worktree that was made from a piece of its own
// chat's work. It is the stop the person presses, reached from the chat that handed the piece off:
// the turn is interrupted and nothing else moves, so the worktree, its files and its chat stay and
// the stopped chat offers the way on. Hence no card: a tool that changes something ends in a card
// where a person has something to gate, and here they would be gating what one press undoes; the
// stop is on the transcript instead, as the stopped chat's own row naming who asked and why. Only
// a worktree born from this chat's piece: one a piece was sent into was on work of its own before
// the piece arrived, and that work is not this chat's to end. Archiving stays the person's.

import type { RepoInfo, WorktreeInfo } from "@toyon/shared";
import { isBusy, STOP_TOOL } from "@toyon/shared";
import type { AgentAdapter } from "../agent/adapter.ts";
import type { McpTool, McpToolResult, ToolProvider } from "../agent/mcp.ts";
import type { StateStore } from "../core/state.ts";
import { handedOrigin } from "./handoff.ts";
import { matchBy } from "./proposals.ts";

export interface StopDeps {
  state: StateStore;
  /** the worktree's agent, when one has been made for it */
  agentFor: (worktreeId: string) => Pick<AgentAdapter, "status" | "stopping" | "queueLength" | "stop"> | undefined;
}

/** a sentence for the stopped chat's row, not an account of the work */
export const REASON_MAX = 300;

const SHAPE = "stop takes { worktree: string, reason: string }.";

const refused = (text: string): McpToolResult => ({ text, isError: true });

export class StopTool implements ToolProvider {
  constructor(private d: StopDeps) {}

  tool(worktreeId: string): McpTool {
    const wt = this.d.state.worktree(worktreeId);
    const made = wt ? this.made(wt) : [];
    const running = made.filter((w) => this.running(w));
    const now =
      made.length === 0
        ? "Right now no open worktree was made from a piece of this chat's work."
        : running.length === 0
          ? "Right now none of the worktrees made from this chat's pieces is running a turn."
          : `Right now you can stop: ${running.map((w) => this.named(wt, w)).join("; ")}.`;
    return {
      name: STOP_TOOL,
      description: `Stop the turn a worktree made from a piece you handed off is running, when its work should not go on: the person said to drop or pause it, or what it builds on changed. It is the stop the person presses and nothing more: the worktree, its files and its chat stay, that chat says this one stopped it and why, and the person can send it on from there. It does not archive or remove the worktree, which is the person's to do in Toyon, and it reaches only worktrees made from this chat's pieces, never one a piece was sent into. ${now}`,
      inputSchema: {
        type: "object",
        properties: {
          worktree: { type: "string", description: "The worktree to stop, by its branch or its title." },
          reason: {
            type: "string",
            description: `Why, in a sentence of at most ${REASON_MAX} characters: the person reads it on that chat's stopped row.`,
          },
        },
        required: ["worktree", "reason"],
        additionalProperties: false,
      },
    };
  }

  call(worktreeId: string, args: unknown): McpToolResult {
    const a = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
    if (!a || typeof a.worktree !== "string" || typeof a.reason !== "string") return refused(SHAPE);
    const wt = this.d.state.worktree(worktreeId);
    if (!wt) return refused("unknown worktree");
    const reason = a.reason.trim();
    if (!reason) return refused("Say why in `reason`: the person reads it on that chat's stopped row.");
    if (reason.length > REASON_MAX) {
      return refused(`The reason is over ${REASON_MAX} characters; say it in a sentence.`);
    }
    const q = a.worktree.trim();
    const bare = q.startsWith("@") ? q.slice(1) : q;
    if (!bare) return refused("Name the worktree to stop, by its branch or its title.");
    const made = this.made(wt);
    const keys = [(w: WorktreeInfo) => w.branch, (w: WorktreeInfo) => w.title];
    const found = matchBy(made, bare, keys);
    if (found.length > 1) {
      return refused(
        `"${q}" names more than one worktree: ${found.map((w) => w.branch).join(", ")}. Say which by its branch.`,
      );
    }
    const target = found[0];
    if (!target) {
      if (bare === "this" || matchBy([wt], bare, keys).length > 0) {
        return refused("That is this worktree; end your own turn by finishing it.");
      }
      // a name that is some other open row's is told apart from a name nothing answers to
      const other = matchBy(
        this.d.state.worktrees.filter((w) => w.id !== wt.id && w.kind === "worktree" && !made.includes(w)),
        bare,
        keys,
      )[0];
      if (other) {
        return refused(
          `"${other.title}" (${other.branch}) was not made from a piece of this chat's work, so it is the person's to stop. Tell them, and name it.`,
        );
      }
      return refused(
        made.length === 0
          ? "No open worktree was made from a piece of this chat's work, so there is nothing here to stop."
          : `No worktree made from this chat's pieces is called "${q}". Those open: ${made.map((w) => this.named(wt, w)).join("; ")}.`,
      );
    }
    const name = `"${target.title}" (${target.branch})`;
    const agent = this.d.agentFor(target.id);
    if (!agent || !this.running(target)) return refused(`${name} is not running a turn; there is nothing to stop.`);
    if (agent.stopping) return refused(`${name} is stopping already.`);
    const waiting = agent.queueLength;
    const project = target.repoId === wt.repoId ? undefined : this.d.state.repo(wt.repoId)?.name;
    if (!agent.stop({ origin: handedOrigin(wt, project), reason })) {
      return refused(`${name} is not running a turn; there is nothing to stop.`);
    }
    const next =
      waiting > 0
        ? ` ${waiting === 1 ? "A message" : `${waiting} messages`} already waiting in that chat ${waiting === 1 ? "goes" : "go"} next, as after any stop.`
        : "";
    return {
      text: `${name} is stopping its turn. Its chat says this one stopped it and why; its worktree and files stay as they are, and the person can send it on or archive it in Toyon.${next}`,
    };
  }

  /** the open worktrees made from a piece of this chat's work, in this project or another */
  private made(wt: WorktreeInfo): WorktreeInfo[] {
    return this.d.state.worktrees.filter(
      (w) => w.kind === "worktree" && w.id !== wt.id && w.from?.kind === "worktree" && w.from.origin.id === wt.id,
    );
  }

  private running(w: WorktreeInfo): boolean {
    return isBusy(this.d.agentFor(w.id)?.status);
  }

  /** a worktree as the tool names it: the branch and the title, with its project when it is not
   * the caller's */
  private named(wt: WorktreeInfo | undefined, w: WorktreeInfo): string {
    const repo: RepoInfo | undefined = wt && w.repoId !== wt.repoId ? this.d.state.repo(w.repoId) : undefined;
    return `${w.branch}, "${w.title}"${repo ? ` in ${repo.name}` : ""}`;
  }
}
