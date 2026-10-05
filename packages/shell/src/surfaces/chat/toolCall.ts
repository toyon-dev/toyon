import {
  ASK_TOOL,
  CHECK_TOOL,
  emptyInput,
  isWrittenKind,
  SHELL_TOOL,
  type Span,
  splitSpanLines,
  TOOL_SEARCH,
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

/** Claude's tools that arrive with no kind, which would otherwise all wear the dot: the glyph is
 * picked by the tool's name instead. A Map, since a name is the agent's string and an object would
 * answer "constructor". A tool not listed here and not kinded (an MCP server's) keeps the dot. */
const NAME_ICON = new Map<string, IconName>([
  // the glyph the ask's parked row wears
  [ASK_TOOL, "chat"],
  // a watch on something running in the background, which reports as time passes
  ["Monitor", "clock"],
  // what a background command or subagent printed
  ["TaskOutput", "terminal"],
  // a packaged set of instructions loaded over the agent's own
  ["Skill", "layers"],
]);

/** a run row's verb says more than "execute" does: `grep -rn x .` is a search and `git commit` is a
 * commit, and the column reads better following the command than the kind. Conservative on purpose:
 * a verb belongs here only when one glyph is right for every use of it, which is why `cp` is not in
 * it, and why `sed` is read by its flags in `verbIcon` instead. */
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

/** `-i` (BSD also takes `-I`), alone or in a cluster (`-ni`, `-i.bak`), or spelled out: the one
 * flag that makes sed write the file it was given. Asked of each sed in the chain and of no other
 * command, since a read is very often `sed -n ...; grep -i ...` and that `-i` is grep's. A script
 * that happens to hold ` -i` trips it: a miss costs the book, never a wrong glyph. */
const SED_IN_PLACE = /(^|\s)(-[A-Za-z]*[iI]|--in-place)/;

/** what stands at the head of a command and only sets the scene: `cd dir &&`, a variable set for
 * the rest of it (`N=notes.md &&`, `export CI=1;`, `FOO=1 cmd`), and an `echo "heading" &&` that
 * labels what the next command prints, and a `mkdir -p dir &&` that makes room for what follows. The
 * work is whatever comes next, so the verb is read from there. A value that runs something
 * (`f=$(grep x)`) is not skipped whole, nor is an echo sent to a file, and such a row keeps the
 * kind's glyph. */
const SCENE_WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|]+)`;
const SCENE = new RegExp(
  String.raw`^\s*(?:(?:cd|echo)\s+${SCENE_WORD}\s*(?:&&|;)|mkdir(?:\s+${SCENE_WORD})+\s*(?:&&|;)|(?:export\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s;&|()\`]*)\s*(?:&&|;|(?=\s)))\s*`,
);

/** a script fed to python on stdin that writes a file: how an agent makes an edit its own edit tool
 * is awkward for, and an edit is what the row should say. One that only prints, `sys.stdout.write`
 * included, is still a run. */
const PYTHON = /^python[\d.]*$/;
const WRITES_FILE = /open\([^)]*,\s*["'][wax]|(?<!std(?:out|err))\.write\(|\.write_text\(/;

function afterScene(command: string): string {
  let rest = command;
  for (let next = rest.replace(SCENE, ""); next !== rest; next = rest.replace(SCENE, "")) rest = next;
  return rest;
}

/** the first command sends what it prints to a file (`>`, `>>`), `/dev/null` and a stream (`2>&1`)
 * aside. A reading verb doing that is writing: `cat > a.ts <<EOF` is how an agent writes a file whole.
 * A `>` inside a quoted pattern trips it too, which costs that row its glyph and nothing more. */
const TO_FILE = /(?<![0-9&])>{1,2}\s*(?!\/dev\/null|&)[^\s&>]/;

const SEPARATOR = /&&|;|\n|\|/;

function sedWrites(command: string): boolean {
  return command.split(SEPARATOR).some((part) => /^\s*(?:\S*\/)?sed\s/.test(part) && SED_IN_PLACE.test(part));
}

/** every command in the chain is a removal. An `rm` with other work after it is very often clearing
 * a scratch directory for that work, and the trash would name the row after its first step; which
 * verb the row is really about cannot be told from here, so it keeps the kind's glyph. `|` and `||`
 * do not end the removal: `rm -rf x 2>&1 | tail` and `rm x || true` are still one. */
function onlyRemoves(rest: string): boolean {
  return rest
    .split(/&&|;|\n/)
    .map((part) => afterScene(part).trim().split(/\s+/)[0] ?? "")
    .filter(Boolean)
    .every((first) => VERB_ICON[first.slice(first.lastIndexOf("/") + 1)] === "trash");
}

function verbIcon(command: string): IconName | undefined {
  const rest = afterScene(command).trim();
  const first = rest.split(/\s+/)[0] ?? "";
  // an absolute path still names the verb: /usr/bin/grep is a grep
  const verb = first.slice(first.lastIndexOf("/") + 1);
  // without -i sed only prints, whatever its script does to the lines on the way
  const icon = verb === "sed" ? (sedWrites(command) ? undefined : "book") : VERB_ICON[verb];
  if (icon === "book" || icon === "search") {
    const head = rest.split(SEPARATOR)[0] ?? "";
    if (TO_FILE.test(head)) return verb === "cat" && head.includes("<<") ? "edit" : undefined;
  }
  if (icon === "trash" && !onlyRemoves(rest)) return undefined;
  if (icon) return icon;
  if (PYTHON.test(verb)) return rest.includes("<<") && WRITES_FILE.test(rest) ? "edit" : undefined;
  return VERB_ICON[verb];
}

export interface ToolCall {
  name: string;
  title?: string;
  input: unknown;
  toolKind?: ToolKind;
  /** the call starts another agent (acp/map.ts): its input is the brief */
  subagent?: boolean;
  /** the spawn returned with its subagent launched, not finished */
  detached?: boolean;
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
  // The name is the tool's programmatic one ("Bash", "WebFetch"). Under a glyph that says the kind,
  // beside a detail that says which, it is the glyph again as a word, and on a running row a
  // second word for the shine to cross. So it prints where the glyph says nothing (a call with no
  // kind of its own) and for a ToolSearch, whose words alone would read as a search of the code.
  // Toyon's own rows (a `!` command, the check after a turn) carry a name for the log to find
  // them by, not a word to print: the glyph and the command already say what ran
  // An ask has no kind either, but it has a glyph of its own, the one its parked row wears.
  const ask = call.name === ASK_TOOL;
  const glyphSays = (kind !== "other" || ask) && call.name !== TOOL_SEARCH;
  const own =
    detail && (glyphSays || call.name === call.title || call.name === SHELL_TOOL || call.name === CHECK_TOOL)
      ? ""
      : call.name;
  // the glyph already says the kind, so the row prints a word only where one adds to it: the tool's
  // own name, or the kind itself on a row with no detail to stand on
  const name = own && own.toLowerCase() !== label ? own : detail ? "" : label;
  // the verb only ever refines a row the kind left generic; an agent that says "read" is read
  const byVerb = (kind === "execute" || kind === "other") && command ? verbIcon(command) : undefined;
  return {
    label: ask ? "ask" : label,
    name,
    // a call sent with no name carries the tool's name as its title
    icon: NAME_ICON.get(call.name) ?? NAME_ICON.get(call.title ?? "") ?? byVerb ?? KIND_ICON[kind],
    hint: detail === name ? "" : detail,
    command: command && command !== detail ? command : "",
  };
}

/** the sentence a spawn's call returns with when Claude Code started the subagent and did not wait */
const ASYNC_SPAWN = /^Async agent launched/m;

/** a spawn the agent sent to the background: its own call returns at once and the subagent goes
 * on without it. Claude says so in the brief, or only in what the call returns with: a harness
 * that backgrounds every spawn takes no flag, and the brief of one reads like a foreground
 * spawn's. The output here is cut to length and opens with the brief, so a long brief hides the
 * sentence; `detached` is the same reading taken off the whole of it, where the call ended. An
 * agent that says none of these is read as waiting on its spawn, which its open call says anyway. */
export function isBackgroundSpawn(call: ToolCall & { output?: string }): boolean {
  if (!call.subagent) return false;
  const input = call.input as Record<string, unknown> | null;
  return !!call.detached || input?.run_in_background === true || (!!call.output && ASYNC_SPAWN.test(call.output));
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
  // an ask has no kind, and its question is the longest input an agent types that nobody sees
  // arrive: the adapter's placeholder ("Asking for your input") says the person is being waited
  // on while there is nothing yet to answer
  if (call.name === ASK_TOOL) return "writing the question";
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

/** the sentence the agent wrote about the call, where it wrote one. The row prints it on one line
 * and cuts it there, and the blocks under the row leave it out, so this is the only whole copy. */
export function callDescription(call: ToolCall): string {
  return field(call, "description");
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
