// The restart a page asks for over plain HTTP, because its socket has stopped: a shell served from
// files newer than the daemon speaks another protocol. `POST /restart` asks, `GET /restart` says
// what the restart is waiting on. Both take the token in the query, like /bootstrap.

/** on `POST /restart`: go without waiting out the chats mid-reply */
export const RESTART_NOW = "now";

/** what `GET /restart` answers */
export interface RestartWait {
  /** the chats a requested restart waits on, by title; empty once it is under way, null when
   * nobody asked */
  waiting: string[] | null;
}
