import type { ToolKind } from "@toyon/shared";
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
  text: string;
}

/** ACP's `name` is optional; agents that omit it get the title as their name, which is the whole
 * call ("grep -rn ... | head -50"), so the row would print the command twice. Name those rows by
 * what kind of call it is and leave the command to the hint. */
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

export interface ToolCall {
  name: string;
  title?: string;
  input: unknown;
  toolKind?: ToolKind;
}

function field(call: ToolCall, key: string): string {
  const input = call.input as Record<string, unknown> | null;
  const v = input ? input[key] : undefined;
  return typeof v === "string" ? v : "";
}

export interface ToolRowText {
  /** what happened: a word */
  name: string;
  /** which thing it happened to: the agent's own description of the call where it wrote one,
   * else the path or command */
  hint: string;
  /** the command, when the hint is the description rather than the command itself */
  command: string;
}

export function toolLabel(call: ToolCall, roots: string[] = []): ToolRowText {
  const command = field(call, "command");
  const v = field(call, "file_path") || command || field(call, "path") || field(call, "pattern");
  const raw = v || (call.title && call.title !== call.name ? call.title : "");
  // Claude's Bash tool sends a sentence of its own ("Build the project"); it beats the command as
  // the row's label, and the command still shows inside
  const detail = relPath(field(call, "description") || raw, roots);
  const name = detail && call.name === call.title ? KIND_LABEL[call.toolKind ?? "other"] : call.name;
  return {
    name,
    hint: detail === name ? "" : detail,
    command: command && command !== detail ? command : "",
  };
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

/** the worktree path is the same forty characters on every row and the part that identifies the
 * file is the tail, which is what a narrow chat pane cuts off first */
export function relPath(detail: string, roots: string[]): string {
  if (!detail.startsWith("/")) return detail;
  for (const root of roots) {
    if (root && detail.startsWith(`${root}/`)) return detail.slice(root.length + 1);
  }
  return detail;
}

const FENCE = /^```([\w+#.-]*)\s*$/;

export function parseToolOutput(out: string): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  let lines: string[] = [];
  let lang = "";
  let fenced = false;
  const flush = () => {
    const text = lines.join("\n").replace(/^\n+|\n+$/g, "");
    if (text) blocks.push({ code: fenced, diff: isDiff(text, lang), text });
    lines = [];
  };
  for (const line of out.split("\n")) {
    const fence = FENCE.exec(line);
    if (!fence) {
      lines.push(line);
      continue;
    }
    flush();
    // an opening fence names the language; the closing one carries nothing
    fenced = !fenced;
    lang = fenced ? (fence[1] ?? "").toLowerCase() : "";
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

export function diffLineKind(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || META.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}
