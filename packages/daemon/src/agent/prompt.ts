// What every agent is told about working inside a toyon worktree, and how a chat message becomes
// an ACP prompt. Agents whose adapter takes a system-prompt override get SYSTEM_APPEND through
// it; the others get it prepended to the first prompt of a session.

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { FileRef, ImageRef, LogLine, PasteRef, PickRef, ProcState, ProcStatus } from "@toyon/shared";
import { attachmentLabel, clipOutput, fmtBytes, lineSpan } from "@toyon/shared";
import type { Stored } from "./attachments.ts";

export const SYSTEM_APPEND = [
  "You are working inside a dedicated git worktree managed by Toyon.",
  "Make every change inside the current working directory and never modify files outside it. Reading files outside it is fine when the user points you there.",
  "A write Toyon refuses (outside the worktree, or to an agent's own settings such as .claude/ or opencode.json) was refused by Toyon and not by the user, who was never asked. Report it as the boundary that stopped it, never as the user declining.",
  "Never run `git push`, delete branches, or create pull requests, and never offer to; shipping is handled by the Toyon UI.",
  "Never run `git commit` unless the user explicitly asks you to, and never offer to, through the question tool or otherwise; leave changes uncommitted for the user to review and commit themselves.",
  "Keep the scope tight: do the asked task well, then stop. A follow-up the user might want later is a sentence in your reply, not a question.",
  "When the work is done and the only thing left is whether to do something you recommend, do not end your turn on a prose offer waiting for a yes. Ask it with your question tool when you have one: one question, two options with the recommended one first, each saying what it changes, and typed text allowed so the answer can carry instructions. The card is the first thing the user reads, before any prose of yours, so the question itself states what you propose and why in a sentence or two; a question that is only the yes-or-no leaves them guessing what it is. Ask this way only where you would otherwise have stopped and waited; never to confirm work already asked for.",
  "An answer to a question of yours can carry typed text beside the option picked, and the text outranks the pick. Text that doubts the pick, asks you something or says the user cannot decide is not a yes: answer it in prose and change nothing until they have decided. Text that only adds detail to the pick is an instruction for carrying it out.",
  "When referencing a file in chat, use a Markdown link whose target is its absolute path, with an optional `:line`; Toyon opens it in the built-in editor, whether it is in this worktree or anywhere else on this machine. A folder, a URL route or a command is not a file: name it in backticks, never as a link.",
  "`@some/path` in a message means read that file or directory first; `@changes` means this worktree's uncommitted files, which `git status` lists.",
  'Toyon previews the project in a browser panel by running the commands in its settings file, .toyon/settings.json (or toyon.json at the repo root, in a repo that keeps it there), shaped like {"setup": ["bun install"], "run": {"web": "bun run dev --port $PORT"}, "check": "bun run check", "land": {"route": "merge"}}: setup runs once in every new worktree, teardown (optional) runs once when a worktree is removed, every command in run keeps running and must listen on $PORT, which toyon sets differently for each worktree, check (optional) runs after each of your turns and must pass before the work can land, and land (optional) says how the user lands work on main: route "merge" (onto main here), "push" (onto main here, then pushed) or "pr" (a pull request); method "merge", "squash" or "rebase" for how the commits arrive on main; automerge true when GitHub should merge the pull request itself; timeouts (optional) gives setup, check and commit each a ceiling as a duration like "30m" (ten minutes each when unset), for a suite that runs longer. A settings.local.json beside it (toyon.local.json at the root) holds one person\'s overrides and is never committed. Both files may carry comments and trailing commas; leave any you find.',
  "Toyon runs those commands itself in every worktree, and the user watches the result live in a preview beside this chat, so never start a dev server or open a browser of your own to check your work. Each message says where this worktree's preview answers; fetch a page from there when you want to see it.",
  "When you scaffold a project, write its .gitignore (dependencies, build output, local env files) before installing anything, so an install never leaves thousands of untracked files for the user to wade through or commit.",
  "When you scaffold a project or change how it installs or starts, finish by updating the settings file Toyon already reads, or writing .toyon/settings.json when there is none, so the preview can run it.",
].join(" ");

/** a failed command as its row on the transcript holds it: the row, the command it names, and
 * what it printed */
export interface FailedRun {
  toolId: string;
  command: string;
  text: string;
}

/** A failure, as whoever met it names it: a hook that refused a commit or a push, a rebase or
 * merge that stopped on conflicts, the repo's check, a command the person ran, a dev server that
 * will not come up. Each is one message to the agent and one line for the person reading the
 * chat; whether it is sent unasked or waits for a press is not said here (see RESPONSE). */
export type Failure =
  | ({ kind: "hook"; hook: string } & FailedRun)
  /** `step` is the rebase or merge that stopped, when one ran */
  | { kind: "conflict"; base: string; how: "rebase" | "merge"; step?: FailedRun }
  | ({ kind: "check" } & FailedRun)
  | ({ kind: "command" } & FailedRun)
  | { kind: "preview"; procs: readonly ProcState[]; log: readonly LogLine[] };

/** the command a failure is about, when it is about one */
export function failedRun(f: Failure): FailedRun | undefined {
  switch (f.kind) {
    case "hook":
    case "check":
    case "command":
      return f;
    case "conflict":
      return f.step;
    case "preview":
      return undefined;
  }
}

/** what the agent is told */
export function fixPrompt(f: Failure): string {
  switch (f.kind) {
    case "hook":
      return hookFixPrompt(f.hook);
    case "conflict":
      return conflictFixPrompt(f.base, f.how, !!f.step);
    case "check":
      return checkFixPrompt(f.command);
    case "command":
      return commandFixPrompt(f.command);
    case "preview":
      return procFixPrompt(f.procs, f.log);
  }
}

/** how much of a command the chat's line names before it is cut */
const WHY_COMMAND_CHARS = 60;

/** what the row on the chat says in the message's place: what failed, in a few words */
export function fixWhy(f: Failure): string {
  switch (f.kind) {
    case "hook":
      return `the ${f.hook} hook refused the ${f.hook.includes("push") ? "push" : "commit"}`;
    case "conflict":
      return f.how === "rebase" ? `the branch needs a rebase onto ${f.base}` : `the branch needs ${f.base} merged in`;
    case "check":
      return "the check failed";
    case "command": {
      const line = f.command.split("\n")[0] ?? "";
      return `\`${line.length > WHY_COMMAND_CHARS ? `${line.slice(0, WHY_COMMAND_CHARS)}...` : line}\` failed`;
    }
    case "preview":
      return "the dev server is not reachable";
  }
}

/** The paragraph that shows the agent what failed: the command and what it printed, clipped the
 * way a `!` command's output is behind a person's message. It rides behind the message as
 * context, since Toyon's own message has no composer to attach it, and the heading is its own:
 * the person did not run a hook or the check. Nothing for a failure that is not about a command,
 * or whose message already carries what was printed. */
export function failureContext(f: Failure): string | undefined {
  const run = failedRun(f);
  if (!run) return undefined;
  const shown = clipOutput(run.text.replace(/\n+$/, ""));
  const what = f.kind === "command" ? "The command that failed" : "What Toyon ran";
  return `${what}, and what it printed:\n$ ${run.command}${shown ? `\n${shown}` : "\n(it printed nothing)"}`;
}

/** What the agent is sent when a hook refuses a commit or a push the person pressed. Never a
 * commit-msg hook, which judges the message and not the tree: that one is answered with a new
 * message. */
function hookFixPrompt(hook: string): string {
  return [
    `The ${hook} hook refused that, and what it printed is attached below.`,
    "Fix what it complains about, inside this worktree.",
    "Do not skip the hook, do not edit it or its configuration to get past it, and do not commit: Toyon runs the check when your turn ends, and the user lands from there.",
  ].join(" ");
}

/** What the agent is sent to clear a conflict, in the words of how the base was being taken in:
 * a merge made to clear a rebase's conflict is one more thing the next sync has to work around,
 * and a merge left uncommitted is not in the branch for it to find. `shown` when the step that
 * stopped is attached. */
function conflictFixPrompt(base: string, how: "rebase" | "merge", shown: boolean): string {
  const ask =
    how === "rebase"
      ? `Rebase this branch onto ${base} and resolve the conflicts, keeping any uncommitted changes, then verify the app still works.`
      : `Merge ${base} into this branch, resolve the conflicts and commit the merge, then verify the app still works.`;
  return shown ? `${ask} What git printed when Toyon tried is attached below.` : ask;
}

/** what the agent is sent when the repo's check fails after its turn */
function checkFixPrompt(command: string): string {
  return [
    `The repo's check, \`${command}\`, failed, and what it printed is attached below.`,
    "Fix what it reports, inside this worktree.",
    "Do not weaken the check or its configuration to get past it. Toyon runs it again when your turn ends.",
  ].join(" ");
}

/** What the agent is sent when the person hands it a command of their own that failed. The
 * command may have failed for a reason outside the tree, and the agent is told it may say so. */
function commandFixPrompt(command: string): string {
  return [
    `The user ran \`${command}\` and it failed; what it printed is attached below.`,
    "Find the cause and fix it, inside this worktree.",
    "If the cause is not in this worktree, say what it is instead of changing anything.",
  ].join(" ");
}

/** how much output the agent gets: the tail that holds the error, not the scrollback */
const PROC_TAIL = 40;

/** What "ask the agent to fix it" sends when a dev server never answered or crashed: the
 * supervisor's diagnosis, the command and the port it was given, the output tail, and the one
 * rule the fix has to satisfy. The agent edits inside its worktree; the daemon restarts a crashed
 * or unreachable proc when the turn ends, so the loop closes without another click. */
export function procFixPrompt(procs: readonly ProcState[], log: readonly LogLine[]): string {
  const bad = procs.filter((p) => p.status === "crashed" || p.status === "unreachable");
  const lines = bad.map((p) => `- \`${p.name}\`: \`${p.command}\`, started with PORT=${p.port}. ${procDiagnosis(p)}`);
  const tail = log
    .slice(-PROC_TAIL)
    .map((l) => `[${l.proc}] ${l.line}`)
    .join("\n");
  return [
    "The dev server in this worktree is not reachable, so the preview is empty.",
    "",
    ...lines,
    "",
    tail ? `Last output:\n\`\`\`\n${tail}\n\`\`\`` : "It produced no output.",
    "",
    "Find the cause and fix it. The command must run in the foreground and listen on the port in the PORT environment variable, which Toyon sets differently for each worktree. If the tool takes its port from a flag instead (Vite does), make the app read PORT, for Vite `server.port: Number(process.env.PORT)` with `strictPort: true`, or add the flag to the start command in toyon's settings file. When your turn ends toyon restarts the process and checks again.",
  ].join("\n");
}

function procDiagnosis(p: ProcState): string {
  if (p.detail) return p.detail;
  if (p.status === "crashed") return p.exitCode != null ? `It exited with code ${p.exitCode}.` : "It crashed.";
  return "It never answered on that port.";
}

/** where the project's preview stands as a message goes out, for the block that tells the agent */
export interface PreviewStanding {
  /** the preview proc's status, "setup" while the worktree is still being made and has no procs,
   * or "parked" on one back from the archive or taken over, whose procs nobody has asked for yet */
  status: ProcStatus | "setup" | "parked";
  /** where the preview proc answers, or will; absent until it has a port */
  url?: string;
  /** the supervisor's diagnosis of a proc that is not answering */
  detail?: string;
}

/** Everything Toyon adds behind a message, wrapped once: what the shell sent with it (the page
 * under the user's eyes, what they ran, a new project's brief) and what the daemon knows as it goes
 * out (where the preview stands, what the tree owes main). One opening, so the agent reads one
 * voice, and the name on it is enough to say the user typed none of it; nothing when there is
 * nothing to say. */
export function ambientBlock(paragraphs: readonly (string | undefined)[]): string | undefined {
  const said = paragraphs.filter((p): p is string => !!p);
  if (said.length === 0) return undefined;
  return `[Attached by Toyon:\n${said.join("\n\n")}]`;
}

/** The paragraph after every message that says where the preview is, so the agent checks its work
 * there instead of starting a server of its own. It goes with each message rather than once at
 * launch: the port lives with the runtime, which a settings change rebuilds under a session that
 * stays up; the first message of a new worktree goes out before setup has given it one; and a proc
 * that ignores $PORT is only found on its real port later. Nothing when there is nothing to run. */
export function previewContext(p: PreviewStanding | null): string | undefined {
  if (!p) return undefined;
  const at = p.url ? ` at ${p.url}` : "";
  let line: string;
  switch (p.status) {
    case "setup":
      line =
        "Toyon is setting this worktree up and starts the preview when that is done; the next message will say where it answers.";
      break;
    case "parked":
      line =
        "The preview is off: Toyon has not started this worktree's dev servers, and starts them when you first write a file or when the user asks for them. Nothing answers until then.";
      break;
    case "starting":
      line = `Toyon is starting the preview; it answers${at} once it is up.`;
      break;
    case "running":
      line = `The preview is running${at}, and the user sees it live beside this chat.`;
      break;
    case "asleep":
      line = `The preview is asleep${p.detail ? ` (${p.detail})` : ""}; it answers${at} once the user opens this worktree again.`;
      break;
    default:
      line = `The preview is ${p.status}${p.detail ? `: ${p.detail}` : ""}; nothing answers${at} until it is back.`;
  }
  return line;
}

/** what the model reads as an image's label: its session number (how the user will refer to it
 * later), where it came from, and where the stored copy is, for a tool that wants the file */
export function imageCaption(ref: ImageRef, path: string): string {
  return `${attachmentLabel("image", ref.n)}: ${ref.name} (${ref.width}×${ref.height}), saved at ${path}`;
}

/** A file is named by where its copy is stored, for the agent's own tools. No resource link
 * beside it, since an adapter flattens one to these same words. `inline` is a file short enough
 * that its text follows the caption, so the path is where it is and not where to go and read it. */
export function fileCaption(ref: FileRef, path: string, inline = false): string {
  const at = `A file the user attached: ${ref.name} (${fmtBytes(ref.bytes)}), saved at ${path}.`;
  return inline ? at : `${at} Read or search it there.`;
}

/** the same for a paste: its number, then where it was copied from or, for text with no file
 * behind it, its size and enough of the first line to tell two apart */
export function pasteCaption(ref: PasteRef): string {
  const label = attachmentLabel("paste", ref.n);
  const s = ref.source;
  if (s) {
    const lines = `${s.startLine === s.endLine ? "line" : "lines"} ${lineSpan(s)}`;
    const at = s.ref ? ` at commit ${s.ref.slice(0, 7)}` : "";
    return `${label} (copied from ${lines} of ${s.path}${at})`;
  }
  const from = ref.name ? `${ref.name}, ` : "";
  return `${label} (${from}${ref.lines} lines, ${ref.chars} chars), begins: ${ref.preview}`;
}

/** the same for an element picked in the preview, named the way its chip names it rather than
 * numbered: a component and its file are already a name. Both files, and which is which: the JSX
 * alone sends the agent into the shared component when the line to change is the one that writes it. */
export function pickCaption(ref: PickRef): string {
  const at = (file: string, line: number | null) => `${file}${line ? `:${line}` : ""}`;
  const what = ref.component ? `<${ref.component} />` : `<${ref.tag}>`;
  const where = ref.callFile
    ? ` used at ${at(ref.callFile, ref.callLine)}${ref.file ? `, its own JSX at ${at(ref.file, ref.line)}` : ""}`
    : ref.file
      ? ` defined at ${at(ref.file, ref.line)}`
      : "";
  const text = ref.text ? `, text "${ref.text}"` : "";
  return `An element the user picked in the preview: ${what}${where}${text}\nits HTML: ${ref.html}`;
}

// An agent only dispatches a slash command when it leads the first text block, so a message that
// opens with one goes ahead of the attachments and SYSTEM_APPEND. Ambient context (the preview's
// route, title, console errors) is dropped from such a message: on the command's line it reads as
// arguments, and in a block of its own it still costs the command its dispatch, since an adapter
// recognises some commands only in a prompt that is the command and nothing else (the Claude
// adapter never runs `/usage` when a second block is present).
const LEADING_COMMAND = /^\/[A-Za-z0-9]/;

/** attachments go first, each behind its caption and in the order they were attached, then the
 * text; context (live-page state) rides after it, except on a message that leads with a slash
 * command, which goes alone. A file goes as its caption, which says where its stored copy is, with
 * a short one's text after it. A
 * message that is attachments alone has no text block: the paste or
 * the picked element is the whole message. The visible transcript only ever shows the text itself. */
export function buildPrompt(
  text: string,
  context?: string,
  prefix?: string,
  attachments: readonly Stored[] = [],
): ContentBlock[] {
  const leads = LEADING_COMMAND.test(text);
  const blocks: ContentBlock[] = [];
  if (leads) {
    blocks.push(textBlock(text));
    if (prefix) blocks.push(textBlock(prefix));
  }
  for (const a of attachments) blocks.push(...attachmentBlocks(a));
  const body = [prefix, text].filter(Boolean).join("\n\n");
  if (!leads && body) blocks.push(textBlock(body));
  if (context && !leads) blocks.push(textBlock(context));
  return blocks;
}

const textBlock = (text: string): ContentBlock => ({ type: "text", text });

function attachmentBlocks(a: Stored): ContentBlock[] {
  switch (a.kind) {
    case "image":
      return [
        textBlock(imageCaption(a.ref, a.path)),
        { type: "image", mimeType: a.ref.mimeType, data: a.bytes.toString("base64") },
      ];
    case "paste":
      return [textBlock(`${pasteCaption(a.ref)}\n<pasted-text ${a.ref.n}>\n${a.text}\n</pasted-text>`)];
    case "file":
      return [
        textBlock(
          a.text === undefined
            ? fileCaption(a.ref, a.path)
            : `${fileCaption(a.ref, a.path, true)}\n<attached-file ${a.ref.n}>\n${a.text}\n</attached-file>`,
        ),
      ];
    case "pick":
      return [textBlock(pickCaption(a.ref))];
  }
}
