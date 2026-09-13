import type { LogLine, ProcState, RepoInfo, WorktreeStatus } from "@toyon/shared";

/** how much output the agent gets: the tail that holds the error, not the scrollback */
const TAIL = 40;

/** What "ask the agent to fix it" sends when a dev server never answered or crashed: the
 * supervisor's diagnosis, the command and the port it was given, the output tail, and the one
 * rule the fix has to satisfy. The agent edits inside its worktree; the daemon restarts a crashed
 * or unreachable proc when the turn ends, so the loop closes without another click. */
export function procFixPrompt(w: WorktreeStatus, log: LogLine[]): string {
  const bad = w.procs.filter((p) => p.status === "crashed" || p.status === "unreachable");
  const lines = bad.map((p) => `- \`${p.name}\`: \`${p.command}\`, started with PORT=${p.port}. ${describe(p)}`);
  const tail = log
    .slice(-TAIL)
    .map((l) => `[${l.proc}] ${l.line}`)
    .join("\n");
  return [
    "The dev server in this worktree is not reachable, so the preview is empty.",
    "",
    ...lines,
    "",
    tail ? `Last output:\n\`\`\`\n${tail}\n\`\`\`` : "It produced no output.",
    "",
    "Find the cause and fix it. The command must run in the foreground and listen on the port in the PORT environment variable, which toyon sets differently for each worktree. If the tool takes its port from a flag instead (Vite does), make the app read PORT, for Vite `server.port: Number(process.env.PORT)` with `strictPort: true`, or add the flag to the start command in toyon's settings file. When your turn ends toyon restarts the process and checks again.",
  ].join("\n");
}

function describe(p: ProcState): string {
  if (p.detail) return p.detail;
  if (p.status === "crashed") return p.exitCode != null ? `It exited with code ${p.exitCode}.` : "It crashed.";
  return "It never answered on that port.";
}

/** What "let the agent work it out" sends from the setup pane: the daemon watches the repo's
 * settings files, so the file the agent writes is picked up the moment it lands. It names the one
 * a save would write, which in a repo that was opened is the local file git never sees. */
export function setupFixPrompt(repo: RepoInfo): string {
  return [
    `This repo (${repo.name}) has no toyon settings yet, so toyon does not know how to install its dependencies or start its dev server.`,
    "",
    `Work it out from the repo itself (package manager, scripts, framework, a README) and write \`${repo.configFile}\` in this shape:`,
    "```json",
    '{ "setup": ["<install command>"], "procs": { "web": "<start command>" } }',
    "```",
    '`setup` runs once in each new worktree. Every command in `procs` must run in the foreground and listen on the port in the PORT environment variable, which toyon sets per worktree; a tool that takes its port from a flag needs the flag (Vite: `--port $PORT --strictPort`, and with npm the `--` before it). Name one proc per server if there are several. If the project has nothing to run (a library, a CLI), write `"procs": {}` and say so. Do not start any server yourself; toyon picks the file up as soon as it is written.',
  ].join("\n");
}
