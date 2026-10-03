/** An error whose message is meant for the person at the shell: it is read where they pressed, on
 * the worktree's chat or under the composer, and not logged as a bug. */
export class UserError extends Error {
  /** the message this error answers reached its agent all the same: said so that a refusal gives a
   * message back to its box only when it went nowhere */
  readonly delivered: boolean;

  constructor(message: string, about: { delivered?: boolean } = {}) {
    super(message);
    this.name = "UserError";
    this.delivered = about.delivered ?? false;
  }
}
