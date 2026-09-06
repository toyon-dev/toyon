/** An error whose message is meant for the person at the shell (shown as a toast, not logged as a bug). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
