// Who is subscribed to which worktree, kept where a service can ask. The socket layer holds its
// subscriptions per socket and nothing below it could see them, so the tree-state owner could not
// tell a worktree someone is reading from one nobody is: the extras tier and the fs.watch hint are
// for the first kind only. The socket's `data` object is the key, as it is for IdlePolicy's view.

export class Interest {
  private keys = new Map<string, Set<object>>();
  private first: Array<(id: string) => void> = [];
  private last: Array<(id: string) => void> = [];

  /** a subscriber appeared; the first for a worktree fires `onFirst` */
  subscribe(key: object, id: string): void {
    let set = this.keys.get(id);
    if (!set) {
      set = new Set();
      this.keys.set(id, set);
    }
    const was = set.size;
    set.add(key);
    if (was === 0) for (const fn of this.first) fn(id);
  }

  /** a subscriber left; the last for a worktree fires `onLast` */
  unsubscribe(key: object, id: string): void {
    const set = this.keys.get(id);
    if (!set?.delete(key)) return;
    if (set.size === 0) {
      this.keys.delete(id);
      for (const fn of this.last) fn(id);
    }
  }

  /** a socket closed: every subscription it held goes */
  drop(key: object): void {
    for (const id of [...this.keys.keys()]) this.unsubscribe(key, id);
  }

  isSubscribed(id: string): boolean {
    return (this.keys.get(id)?.size ?? 0) > 0;
  }

  /** every worktree with a subscriber */
  subscribed(): string[] {
    return [...this.keys.keys()];
  }

  onFirst(fn: (id: string) => void): void {
    this.first.push(fn);
  }

  onLast(fn: (id: string) => void): void {
    this.last.push(fn);
  }
}
