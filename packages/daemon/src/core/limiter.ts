// Keyed counting semaphores: at most `max` callers hold a key at once, and the rest wait in call
// order. Where the lock in git/lock.ts serialises, this admits a few: the repo's check is a
// typecheck and a test run, and a repo whose worktrees settle their turns together would run one
// per worktree, each slower than the last, until every verdict is late. A slot is handed to the
// next waiter directly rather than freed for whoever asks first, so a caller that arrives while
// waiters stand cannot slip ahead of them and the count never passes the cap.

interface Gate {
  held: number;
  waiting: Array<() => void>;
}

const gates = new Map<string, Gate>();

export async function withSlot<T>(key: string, max: number, fn: () => Promise<T> | T): Promise<T> {
  let gate = gates.get(key);
  if (!gate) {
    gate = { held: 0, waiting: [] };
    gates.set(key, gate);
  }
  if (gate.held < max) gate.held++;
  else await new Promise<void>((admit) => gate.waiting.push(admit));
  try {
    return await fn();
  } finally {
    const next = gate.waiting.shift();
    if (next) next();
    else if (--gate.held === 0) gates.delete(key);
  }
}

/** how many stand behind the holders of a key, for a log line or a test */
export function waitingFor(key: string): number {
  return gates.get(key)?.waiting.length ?? 0;
}
