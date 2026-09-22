import {
  CHECK_TOOL,
  emptyInput,
  isWrittenKind,
  SHELL_TOOL,
  type Span,
  splitSpanLines,
  type ToolKind,
  type WrittenKind,
  wordSpans,
} from "@toyon/shared";
import type { IconName } from "../../ui/Icon.tsx";
/** How a tool call reads in the transcript: the two halves of its summary line, and the blocks of
 * its output. */

/** Tool output arrives as the agent wrote it: a sentence of prose, then a ```console block, then
 * maybe a diff. Dumping that into one <pre> printed the fences as text, so the transcript read as
 * broken markdown. Split it into the blocks the agent meant, and mark the ones that are diffs so
 * their lines can be colored. */

export interface OutputBlock {
  /** a fenced block, or a run of lines that is itself a diff */
  code: boolean;
  /** +/- lines in here are additions and deletions, not text that happens to start with a dash */
  diff: boolean;
  /** the word on the opening fence, where the agent wrote one: what the block is written in */
  lang: string;
  text: string;
}

/** ACP's `name` is optional. The daemon preserves that omission as an empty string so the title can
 * describe the call; a raw command title is still kept out of the name column and shown as the
 * hint. Name those rows by what kind of call it is and leave the detail to the hint. */
const KIND_LABEL: Record<ToolKind, string> = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  execute: "run",
  think: "think",
  fetch: "fetch",
  switch_mode: "mode",
  other: "tool",
};

/** the row's glyph. A name is a word the agent chose and varies per agent ("Bash", "run_command");
 * the kind is the one thing every agent agrees on, so the icon column stays the same down the
 * transcript whatever is driving it. `other` gets a bare marker rather than the agent's mark: the
 * agent is the same on every row of the turn, so its logo would say nothing about the call, and
 * `more` is the overflow menu everywhere else in the shell. */
const KIND_ICON: Record<ToolKind, IconName> = {
  read: "book",
  edit: "edit",
  delete: "trash",
  move: "move",
  search: "search",
  execute: "run",
  think: "bulb",
  fetch: "globe",
  switch_mode: "swap",
  other: "dot",
};

/** a run row's verb says more than "execute" does: `grep -rn x .` is a search and `git commit` is a
 * commit, and the column reads better following the command than the kind. Conservative on purpose:
 * a verb belongs here only when one glyph is right for every use of it, which is why `sed` (a read
 * with -n, an edit with -i) and `cp` are not in it. */
const VERB_ICON: Record<string, IconName> = {
  grep: "search",
  rg: "search",
  ag: "search",
  ack: "search",
  find: "search",
  fd: "search",
  cat: "book",
  head: "book",
  tail: "book",
  nl: "book",
  less: "book",
  bat: "book",
  ls: "folder",
  tree: "folder",
  mkdir: "folder",
  rm: "trash",
  rmdir: "trash",
  mv: "move",
  curl: "globe",
  wget: "globe",
  git: "branch",
};

function verbIcon(command: string): IconName | undefined {
  const first = command.trim().split(/\s+/)[0] ?? "";
  // an absolute path still names the verb: /usr/bin/grep is a grep
  return VERB_ICON[first.slice(first.lastIndexOf("/") + 1)];
}

export interface ToolCall {
  name: string;
  title?: string;
  input: unknown;
  toolKind?: ToolKind;
  /** the call starts another agent (acp/map.ts): its input is the brief */
  subagent?: boolean;
}

function field(call: ToolCall, key: string): string {
  const input = call.input as Record<string, unknown> | null;
  const v = input ? input[key] : undefined;
  return typeof v === "string" ? v : "";
}

export interface ToolRowText {
  /** what happened, as a word: the row's accessible name, since the glyph carries it on screen */
  label: string;
  /** the agent's own word for the tool, printed only where it says more than the glyph does */
  name: string;
  /** what happened, as a glyph, so the rows scan as a column */
  icon: IconName;
  /** which thing it happened to: the agent's own description of the call where it wrote one,
   * else the path or command */
  hint: string;
  /** the command, when the hint is the description rather than the command itself */
  command: string;
}

/** The shell a command was wrapped in, where the adapter sent the wrapper along: Codex runs its
 * shell tool as `/bin/zsh -lc '<command>'`, and printed whole that line is the same forty characters
 * on every row with the command hidden behind them, and its verb reads as `zsh`. Only a whole
 * wrapper goes: a shell, its flags, and one quoted string that is the entire argument, so a command
 * that merely starts with `sh` keeps itself. A double-quoted string gets its escapes back. */
const SHELL_WRAP = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+(?:-[a-zA-Z]+\s+)*(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*$/;

export function unwrapShell(command: string): string {
  const m = SHELL_WRAP.exec(command.trim());
  if (!m) return command;
  if (m[1] !== undefined) return m[1];
  return (m[2] ?? "").replace(/\\(["\\$`])/g, "$1");
}

/** Codex's guardian review, a think-kind call whose output is a report of `Key: value` lines: a
 * Status per update (in progress, then the verdict), then the risk and the rationale. The row says
 * the verdict and the risk, and the report is inside. */
export const GUARDIAN_TITLE = "Guardian Review";

export function isGuardian(call: ToolCall): boolean {
  return call.toolKind === "think" && call.title === GUARDIAN_TITLE;
}

export function guardianHint(output: string): string {
  const last = (key: string) => {
    const hits = [...output.matchAll(new RegExp(`^${key}:[ \\t]*(.+)$`, "gm"))];
    return hits.at(-1)?.[1]?.trim().toLowerCase() ?? "";
  };
  const status = last("Status");
  const risk = last("Risk");
  if (!status || status === "in progress") return "reviewing";
  return risk ? `${status}, ${risk} risk` : status;
}

export function toolLabel(call: ToolCall, roots: string[] = []): ToolRowText {
  const command = unwrapShell(field(call, "command"));
  const v = filePathOf(call) || command || field(call, "path") || field(call, "pattern");
  const raw = v || (call.title && call.title !== call.name ? call.title : "");
  // Claude's Bash tool sends a sentence of its own ("Build the project"); it beats the command as
  // the row's label, and the command still shows inside
  const detail = relPath(field(call, "description") || raw, roots);
  // the maps are exhaustive over ToolKind, so a kind added to ACP is a compile error rather than a
  // blank glyph. A replayed transcript line is JSON.parse'd and cast, though, so a kind written by
  // an older toyon can be a string neither map has: fall back rather than print "undefined".
  const kind = call.toolKind && call.toolKind in KIND_ICON ? call.toolKind : "other";
  const label = KIND_LABEL[kind];
  // the agent's own word for the tool, where it sent one rather than the whole call as its name.
  // Toyon's own rows (a `!` command, the check after a turn) carry a name for the log to find
  // them by, not a word to print: the glyph and the command already say what ran
  const own =
    detail && (call.name === call.title || call.name === SHELL_TOOL || call.name === CHECK_TOOL) ? "" : call.name;
  // the glyph already says the kind, so the row prints a word only where one adds to it: the tool's
  // own name, or the kind itself on a row with no detail to stand on
  const name = own && own.toLowerCase() !== label ? own : detail ? "" : label;
  // the verb only ever refines a row the kind left generic; an agent that says "read" is read
  const byVerb = (kind === "execute" || kind === "other") && command ? verbIcon(command) : undefined;
  return {
    label,
    name,
    icon: byVerb ?? KIND_ICON[kind],
    hint: detail === name ? "" : detail,
    command: command && command !== detail ? command : "",
  };
}

/** what the row says while a kind's input streams in, in place of the path or command it has not
 * got yet, so the line reads as a status and not as a file called "writing". "writing" where the
 * agent is composing something (a command, a change, a search), "choosing" where the only thing
 * streaming is which file: a read is not writing anything a person would call written, and
 * "writing" under a file glyph reads as a file write. Typed over the kinds whose input the agent
 * types out token by token, so a kind that joins that set is a compile error here until it has a
 * phrase. */
const WRITING: Record<WrittenKind, string> = {
  read: "choosing a file",
  edit: "writing the change",
  delete: "choosing a file",
  move: "choosing the files",
  search: "writing the search",
  execute: "writing the command",
  fetch: "writing the url",
};

/** The agent has opened the call but its input has not arrived: what the row says meanwhile, or
 * "" once the input is in. The adapter names such a row after the tool ("Terminal", "Preparing
 * file…"), which reads as the tool stalled rather than as the agent typing, so the row says what is
 * happening instead. The input lands whole (the daemon holds back the field-by-field refines), so
 * a long script stays here for as long as it takes to write. A call the agent never finished
 * writing (a message sent mid-turn cuts the generation off) ends with no input, which is what
 * `cutOff` in group.ts reads it by. */
export function composing(call: ToolCall): string {
  const kind = call.toolKind;
  if (!emptyInput(call.input)) return "";
  // a spawn's kind is "think", which is whole on arrival for every other call of that kind; the
  // brief is what the agent writes here, and until it lands the row would say "Task" with a
  // count of no calls, which reads as a subagent that never started
  if (call.subagent) return "writing the brief";
  return isWrittenKind(kind) ? WRITING[kind] : "";
}

/** the blocks to show under the row: the adapter repeats the description as the first line of the
 * output, and the summary already carries it */
export function toolBlocks(call: ToolCall, output: string): OutputBlock[] {
  const blocks = parseToolOutput(output);
  const first = blocks[0];
  const description = field(call, "description");
  if (description && first && !first.code && first.text === description) return blocks.slice(1);
  return blocks;
}

/** the file the call names, where it names one. Unlike the row's hint this stays absolute and keeps
 * its extension, which is what says the language a diff under it is written in. */
export function callPath(call: ToolCall): string {
  return filePathOf(call) || field(call, "path");
}

/** the file an edit or a read names: Claude says file_path, OpenCode filepath, and an adapter that
 * titles the call in prose ("Read file '/x'") still names it in ACP's own `locations`. The file is
 * the row, not the sentence around it: relative, it is the same line Claude's read prints. */
function filePathOf(call: ToolCall): string {
  return field(call, "file_path") || field(call, "filepath") || field(call, "filePath") || locationOf(call);
}

function locationOf(call: ToolCall): string {
  const input = call.input as { locations?: unknown } | null;
  const first = Array.isArray(input?.locations) ? input.locations[0] : undefined;
  const path = first && typeof first === "object" ? (first as { path?: unknown }).path : undefined;
  return typeof path === "string" ? path : "";
}

/** the worktree path is the same forty characters on every row and the part that identifies the
 * file is the tail, which is what a narrow chat pane cuts off first */
export function relPath(detail: string, roots: string[]): string {
  if (!detail.startsWith("/")) return detail;
  for (const root of roots) {
    if (root && detail.startsWith(`${root}/`)) return detail.slice(root.length + 1);
  }
  return detail;
}

/** three backticks or more: an adapter fencing a file that holds a fence of its own writes a
 * longer one around it, and the block closes on a fence at least that long */
const FENCE = /^(`{3,})([\w+#.-]*)\s*$/;

export function parseToolOutput(out: string): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  let lines: string[] = [];
  let lang = "";
  let fenced = false;
  let open = 0;
  const flush = () => {
    // blank lines around a block go; the indentation inside it stays, being the shape of the code.
    // A block that is nothing but whitespace is not a block: a command that printed one newline
    // would otherwise draw an empty bar under the row.
    const text = lines.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.trim()) blocks.push({ code: fenced, diff: isDiff(text, lang), lang: fenced ? lang : "", text });
    lines = [];
  };
  for (const line of out.split("\n")) {
    const fence = FENCE.exec(line);
    const ticks = fence?.[1]?.length ?? 0;
    // inside a block, a shorter fence is a line of the code and not the end of it
    if (!fence || (fenced && (ticks < open || fence[2]))) {
      lines.push(line);
      continue;
    }
    flush();
    // an opening fence names the language; the closing one carries nothing
    fenced = !fenced;
    open = fenced ? ticks : 0;
    lang = fenced ? (fence[2] ?? "").toLowerCase() : "";
  }
  flush();
  return blocks;
}

/** conservative on purpose: a lone "-" line in help text is not a deletion, so a block counts as a
 * diff only once it carries a marker no ordinary output has */
function isDiff(text: string, lang: string): boolean {
  if (lang === "diff" || lang === "patch") return true;
  if (/^diff --git /m.test(text)) return true;
  if (/^@@ .*@@/m.test(text)) return true;
  // the daemon's own diff blocks: a "--- path" header over -/+ lines (acp/map.ts)
  return /^--- /m.test(text) && /^[+-]/m.test(text);
}

export type LineKind = "add" | "del" | "hunk" | "meta" | "";

const META =
  /^(diff --git |index [0-9a-f]+\.\.|new file mode |deleted file mode |similarity index |rename (from|to) |Binary files )/;

export interface DiffLine {
  kind: LineKind;
  text: string;
  /** on an added or deleted line, which of its words are the change: a rewritten line keeps the
   * parts it kept, a line with no counterpart is one span of changed text. Empty on every other
   * kind, and on a blank line, where the band alone says it. */
  spans?: Span[];
}

/** what a diff block shows: the tint says which side a line is on, so the marker column is noise
 * (unified diffs indent context lines by one space, so dropping one character keeps code aligned).
 * The file headers go too, since the row above already names the file; `diff --git` stays, being the
 * only header that tells one file from the next when a block covers several. */
export function diffLines(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const line of text.split("\n")) {
    const kind = diffLineKind(line);
    if (kind === "meta" && !line.startsWith("diff --git ")) continue;
    const bare = kind === "add" || kind === "del" || line.startsWith(" ");
    out.push({ kind, text: bare ? line.slice(1) : line });
  }
  markWords(out);
  return out;
}

/** A run of deletions followed by a run of additions is one stretch of the file rewritten: diff the
 * two runs against each other by word and mark only what actually differs, so text that carried over
 * reads as carried over rather than as a whole line deleted and a near-identical one added. The run
 * goes in whole rather than line against line, which is what lets a rewrite that dropped a line line
 * the rest of itself back up. */
function markWords(lines: DiffLine[]): void {
  for (let i = 0; i < lines.length; ) {
    if (lines[i]?.kind !== "del" && lines[i]?.kind !== "add") {
      i++;
      continue;
    }
    let mid = i;
    while (lines[mid]?.kind === "del") mid++;
    let end = mid;
    while (lines[end]?.kind === "add") end++;
    const dels = lines.slice(i, mid);
    const adds = lines.slice(mid, end);
    const pair =
      dels.length > 0 && adds.length > 0
        ? wordSpans(dels.map((l) => l.text).join("\n"), adds.map((l) => l.text).join("\n"))
        : null;
    if (pair) {
      apply(dels, splitSpanLines(pair.before));
      apply(adds, splitSpanLines(pair.after));
    }
    // A run with no counterpart, or one too unlike its counterpart to be the same lines edited, is a
    // change entire and carries no marks: the band says that already, and marking every character
    // as well is the same tint painted twice, which is what turns a newly added file into the
    // loudest thing in the window. The diff pane draws its character ranges under its line tint for
    // exactly this reason (see editor/Editor.tsx). A mark is for placing an edit among lines that carried
    // over, so a line wholly rewritten inside such a run does keep one.
    for (const line of [...dels, ...adds]) line.spans ??= [];
    i = end;
  }
}

function apply(lines: DiffLine[], spans: Span[][]): void {
  // the runs were joined with the newlines they had, so the split gives one list back per line
  if (spans.length !== lines.length) return;
  for (const [i, line] of lines.entries()) line.spans = spans[i];
}

export function diffLineKind(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || META.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}
