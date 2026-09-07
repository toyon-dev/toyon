// Clean log lines out of a pty's raw bytes. The pane renders the bytes; everything that is not a
// pane (the preview placeholder, the reconnect backfill) reads lines. Piped stdio handed us lines
// for free, so this is what a pty costs: a screen has to be turned back into a transcript.

/** flushed as a line even without a newline, so a proc that never emits one (a spinner redrawing
 * itself forever) cannot grow the pending buffer without bound */
const MAX_PENDING = 64 * 1024;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI means matching ESC and BEL
const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** what a terminal would leave on the line once the process moved on: escape sequences gone, and
 * a `\r` rewrite (a progress bar redrawing in place) collapsed to the last thing written */
function clean(raw: string): string {
  const parts = raw.replace(ANSI, "").split("\r");
  while (parts.length > 1 && !parts[parts.length - 1]?.trim()) parts.pop();
  return (parts[parts.length - 1] ?? "").trimEnd();
}

/** One per stream. Buffers across chunks, since a pty read can end mid-line or mid-escape: the
 * piped reader used to split every chunk on its own and shipped torn halves as two lines. */
export class LineSplitter {
  private pending = "";

  /** the lines this chunk completed; blank ones are dropped, as the piped reader did */
  feed(chunk: string): string[] {
    this.pending += chunk;
    const out: string[] = [];
    for (let nl = this.pending.indexOf("\n"); nl !== -1; nl = this.pending.indexOf("\n")) {
      const line = clean(this.pending.slice(0, nl));
      this.pending = this.pending.slice(nl + 1);
      if (line) out.push(line);
    }
    if (this.pending.length > MAX_PENDING) {
      const line = clean(this.pending);
      this.pending = "";
      if (line) out.push(line);
    }
    return out;
  }
}
