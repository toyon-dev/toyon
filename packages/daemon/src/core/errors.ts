/** An error whose message is meant for the person at the shell: it is read where they pressed, on
 * the worktree's chat or under the composer, and not logged as a bug. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
