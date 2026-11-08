// The `own` tool: the agent asks Toyon to run a shared proc in its worktree now, ahead of the edit
// that would flip it. The flip itself needs no asking: the moment a changed file touches the
// proc's paths the daemon takes it over, with no card, since nothing a person decides is in it.
// This tool does the same thing one edit earlier, so the proc's setup and start run while the
// agent writes, and the page is already talking to the branch when the edit lands. Hence no card
// here either (the 2026-10-06 ruling that a tool which changes something ends in a card is about
// what a person has to gate; a card here would gate what the edit path never gates and decide
// nothing); the transcript gets the same note the flip posts. It refuses in plan mode, where the
// agent writes nothing and the flip could never fire. It answers at once: the take-over waits up
// to a minute for the proc, and a tool that waits on that holds the agent for nothing.

import { OWN_TOOL, runSetup as procSetup, remoteOf } from "@toyon/shared";
import type { McpTool, McpToolResult, ToolProvider } from "../agent/mcp.ts";
import { fireAndForget } from "../core/log.ts";
import type { StateStore } from "../core/state.ts";
import { configFor } from "../repos/config.ts";
import { urlVarOf } from "../runtime/registry.ts";
import { resolveRun } from "../runtime/run.ts";

export interface OwnDeps {
  state: StateStore;
  /** the service's take-over, fired and not awaited */
  own: (worktreeId: string, names: string[]) => Promise<void>;
}

const refused = (text: string): McpToolResult => ({ text, isError: true });
const list = (names: string[]) => names.join(", ");

export class OwnTool implements ToolProvider {
  constructor(private d: OwnDeps) {}

  tool(worktreeId: string): McpTool {
    const wt = this.d.state.worktree(worktreeId);
    const repo = wt && this.d.state.repo(wt.repoId);
    const borrowed = wt && repo ? resolveRun(configFor(wt, repo), wt, repo.tier ?? {}).borrowed : [];
    const now =
      borrowed.length > 0
        ? `Right now this worktree reaches ${list(borrowed)} on main.`
        : "Right now nothing here runs on main.";
    return {
      name: OWN_TOOL,
      description: `Run a command this worktree reaches on main here instead, before you change its files. Toyon does this on its own the moment a changed file touches the command's paths; calling it first means the server is already up when the edit lands. ${now} Nothing changes for the page: it keeps its <NAME>_URL addresses.`,
      inputSchema: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description:
              "The commands to run here, by their names in the settings file. Leave it out for every command this worktree reaches on main.",
          },
        },
        additionalProperties: false,
      },
    };
  }

  call(worktreeId: string, args: unknown): McpToolResult {
    const names = parseNames(args);
    if (names === null) return refused("own takes { names?: string[] }.");
    const wt = this.d.state.worktree(worktreeId);
    const repo = wt && this.d.state.repo(wt.repoId);
    if (!wt || !repo) return refused("unknown worktree");
    if (wt.kind === "main") {
      return refused("This is the project's main checkout; it runs every command for the other worktrees already.");
    }
    const cfg = configFor(wt, repo);
    const run = resolveRun(cfg, wt, repo.tier ?? {});
    if (run.shared.length === 0) {
      return refused("Nothing in this project is shared: every command runs in this worktree already.");
    }
    if (wt.mode === "plan") {
      const which = names?.length ? list(names) : list(run.borrowed) || "the backend";
      return refused(
        `This worktree is in plan mode; nothing runs until the plan is approved. Say in the plan that ${which} will run here.`,
      );
    }
    for (const n of names ?? []) {
      if (!(n in run.procs)) {
        return refused(
          `No command "${n}" in ${cfg.file}. The commands this worktree reaches on main: ${list(run.borrowed) || "none"}.`,
        );
      }
      if (n in run.pointed) {
        return refused(
          `The page here points ${n} at ${remoteOf(wt.sources?.[n]?.at)} (${run.pointed[n]}). Toyon does not move it for you: tell the user that ${n} edits here are not what the page talks to, and that the chip on this row moves it to main or here.`,
        );
      }
      if (!run.borrowed.includes(n)) return refused(`${n} already runs here.`);
    }
    const take = names ?? run.borrowed;
    if (take.length === 0) return refused("Nothing here runs on main: every command runs in this worktree already.");
    const setup = take.filter((n) => procSetup(cfg.config.run[n] ?? "").length > 0 && !wt.sources?.[n]?.prepared);
    fireAndForget(worktreeId, this.d.own(worktreeId, take), "own tool");
    const one = take.length === 1;
    const vars = take.map(urlVarOf).join(" and ");
    const first = `${list(take)} ${one ? "starts" : "start"} here now; ${vars} ${one ? "does" : "do"} not change.`;
    const second =
      setup.length > 0 ? ` ${list(setup)} ${setup.length === 1 ? "runs its" : "run their"} own setup first.` : "";
    return { text: `${first}${second}` };
  }
}

/** the names asked for, undefined when none were, null when the shape is wrong */
function parseNames(args: unknown): string[] | undefined | null {
  if (args === undefined || args === null) return undefined;
  if (typeof args !== "object") return null;
  const names = (args as { names?: unknown }).names;
  if (names === undefined) return undefined;
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && n.length > 0)) return null;
  return [...new Set(names)];
}
