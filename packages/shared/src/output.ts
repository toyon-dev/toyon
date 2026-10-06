// How much of a command's output the agent is shown, whoever attaches it: the shell, behind a
// message the person typed, or the daemon, behind one it sends itself.

/** how much of one command's output the agent is shown: enough for a log or a listing, not a
 * whole file the agent could read for itself */
const CONTEXT_CHARS = 6_000;
/** of that, how much is the opening. The rest is the end, because a test run or a hook prints
 * what went wrong and its summary last, and an opening alone of a long run is the part that passed */
const HEAD_CHARS = 1_500;

/** the output within CONTEXT_CHARS: whole when it fits, else its opening and its end with a note
 * of how much between them went */
export function clipOutput(text: string): string {
  if (text.length <= CONTEXT_CHARS) return text;
  const cut = text.length - CONTEXT_CHARS;
  return `${text.slice(0, HEAD_CHARS)}\n[${cut} characters cut here]\n${text.slice(text.length - (CONTEXT_CHARS - HEAD_CHARS))}`;
}
