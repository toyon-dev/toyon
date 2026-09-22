// Clean log lines out of a pty's raw bytes. The pane renders the bytes; everything that is not a
// pane (the preview placeholder, the reconnect backfill) reads lines. Piped stdio handed us lines
// for free, so this is what a pty costs: a screen has to be turned back into a transcript.

/** flushed as a line even without a newline, so a proc that never emits one (a spinner redrawing
 * itself forever) cannot grow the pending buffer without bound */
const MAX_PENDING = 64 * 1024;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI means matching ESC and BEL
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** cursor up n, or to the start of the nth line up: the other way a progress bar redraws. A bar
 * that spans lines (yarn's, pnpm's) climbs over the frame it drew and prints the next one on top,
 * every line newline-terminated, so a transcript that only stripped the escapes would keep each
 * frame as its own rows. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC
const UP = /\u001b\[(\d*)[AF]/g;

/** One step of a transcript: drop the last `retract` lines this stream wrote, then add `line`
 * when it is not empty. A bar wiped as its process moves on is a retract alone. */
export interface LogEvent {
  line: string;
  retract: number;
}

/** what a terminal would leave on the line once the process moved on: escape sequences gone, and
 * a `\r` rewrite (a progress bar redrawing in place) collapsed to the last thing written */
function clean(raw: string): string {
  const parts = raw.replace(ANSI, "").split("\r");
  while (parts.length > 1 && !parts[parts.length - 1]?.trim()) parts.pop();
  return (parts[parts.length - 1] ?? "").trimEnd();
}

/** how many lines the cursor-up sequences in `raw` climb, and `raw` without them */
function takeUps(raw: string): [string, number] {
  let n = 0;
  const rest = raw.replace(UP, (_, count: string) => {
    n += count === "" ? 1 : Number(count);
    return "";
  });
  return [rest, n];
}

/** One per stream. Buffers across chunks, since a pty read can end mid-line or mid-escape. */
export class LineSplitter {
  private pending = "";

  /** the lines this chunk completed, blank ones dropped, with the lines they climbed over */
  feed(chunk: string): LogEvent[] {
    this.pending += chunk;
    const out: LogEvent[] = [];
    const emit = (raw: string) => {
      const [rest, retract] = takeUps(raw);
      const line = clean(rest);
      if (line || retract) out.push({ line, retract });
    };
    for (let nl = this.pending.indexOf("\n"); nl !== -1; nl = this.pending.indexOf("\n")) {
      const raw = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      emit(raw);
    }
    if (this.pending.length > MAX_PENDING) {
      const raw = this.pending;
      this.pending = "";
      emit(raw);
      return out;
    }
    // a climb acts as soon as it is whole, not when its line ends: a bar wiped at exit is climbed
    // over and erased, and no newline follows
    const [rest, retract] = takeUps(this.pending);
    if (retract) {
      this.pending = rest;
      out.push({ line: "", retract });
    }
    return out;
  }
}
