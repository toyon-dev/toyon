// Daemon logger. One line per event on stderr: `HH:MM:SS level [tag] message {extra}`.
// Level from TOYON_LOG (debug | info | warn | error), default info.
// Every swallowed catch in the daemon should go through log.warn so a failure
// is at least visible in ~/.toyon/daemon.log instead of vanishing.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): LogLevel {
  const v = process.env.TOYON_LOG;
  return v && v in LEVELS ? (v as LogLevel) : "info";
}

let threshold = LEVELS[envLevel()];

/** the errors that are the daemon's own doing: for these the stack names the line, which the
 * message cannot. A refusal, a git failure or a closed connection says all it has in its message,
 * and its frames were a seventh of a month's log without naming anything the message did not. */
const BUGS = [TypeError, RangeError, ReferenceError, SyntaxError];

/** What a JSON-RPC error carries beside its message. An agent's handler that threw is answered
 * with the code's name alone ("Internal error") and the thrown words under `data.details`, so the
 * message by itself names no cause. Read by shape: the log sits under the agent code and
 * imports none of it. */
function details(e: Error): string {
  const d = (e as { data?: { details?: unknown } | null }).data?.details;
  return typeof d === "string" && d ? `: ${d.split("\n")[0]}` : "";
}

function fmtError(level: LogLevel, e: Error): string {
  const head = `${e.name}: ${e.message}`;
  const line = head + details(e);
  const whole = level === "error" || threshold <= LEVELS.debug || BUGS.some((c) => e instanceof c);
  if (!whole || !e.stack) return line;
  return e.stack.startsWith(head) ? line + e.stack.slice(head.length) : e.stack;
}

function fmtExtra(level: LogLevel, extra: unknown): string {
  if (extra === undefined) return "";
  if (extra instanceof Error) return ` ${fmtError(level, extra)}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

/** one line as the log writes it, without the newline */
export function formatLine(
  level: LogLevel,
  tag: string,
  message: string,
  extra?: unknown,
  iso = new Date().toISOString(),
): string {
  return `${iso.slice(11, 19)} ${level.padEnd(5)} [${tag}] ${message}${fmtExtra(level, extra)}`;
}

/** the day the last line was written on; the file spans restarts and days, and a reader working
 * out why something was up needs to know which morning a line belongs to */
let lastDay = "";

function write(level: LogLevel, tag: string, message: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const iso = new Date().toISOString();
  const day = iso.slice(0, 10);
  if (day !== lastDay) {
    lastDay = day;
    process.stderr.write(`-------- ${day} --------\n`);
  }
  process.stderr.write(`${formatLine(level, tag, message, extra, iso)}\n`);
}

export const log = {
  debug: (tag: string, message: string, extra?: unknown) => write("debug", tag, message, extra),
  info: (tag: string, message: string, extra?: unknown) => write("info", tag, message, extra),
  warn: (tag: string, message: string, extra?: unknown) => write("warn", tag, message, extra),
  error: (tag: string, message: string, extra?: unknown) => write("error", tag, message, extra),
  setLevel(level: LogLevel) {
    threshold = LEVELS[level];
  },
};

/** Run a promise in the background: a rejection is logged under `tag` instead of killing the daemon
 * (Bun exits on unhandled rejections). Use for every fire-and-forget call. */
export function fireAndForget(tag: string, p: Promise<unknown>, what = "background task"): void {
  p.catch((e) => log.warn(tag, `${what} failed`, e));
}
