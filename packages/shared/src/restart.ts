// The restart a page asks for over plain HTTP, because its socket has stopped: a shell served from
// files newer than the daemon speaks another protocol. `POST /restart` asks, `GET /restart` says
// what the restart is waiting on. Both take the token in the query, like /bootstrap.

/** on `POST /restart`: go without waiting out the chats mid-reply */
export const RESTART_NOW = "now";

/** What `GET /restart` answers. The page reading it was built after the daemon answering, always,
 * so this shape only grows: a field is added and never renamed, and the page reads one that is
 * missing as empty. */
export interface RestartWait {
  /** the chats a requested restart waits on, by title; empty once it is under way, null when
   * nobody asked */
  waiting: string[] | null;
  /** the chats stopped on a question, by title: not waited on, and they resume after the restart */
  asking: string[];
}
