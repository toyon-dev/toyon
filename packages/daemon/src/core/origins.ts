// Which origins are this daemon's own: the ones it serves its shell from, as things stand. The
// bridge reports to these and to the origins let in from elsewhere; a knock from one of them is a
// device at this machine's own address and not a page from another Toyon; and on the loopback
// name a loopback origin (a second daemon on this box, the Vite dev shell) is answered across
// origins. One place decides, so adding a served origin is one line.

import { isLoopbackHost, SHELL_DEV_PORT } from "@toyon/shared";
import type { RemoteSetting } from "./remote.ts";

export interface OriginsDeps {
  setting: RemoteSetting;
  port: number;
  /** whether the portless http://toyon.localhost listener came up; known after bind */
  branded: () => boolean;
}

export class Origins {
  constructor(private d: OriginsDeps) {}

  /** every origin this daemon serves its shell from. Behind an edge nothing is loopback, so the
   * public name is the one. */
  own(): string[] {
    const remote = this.d.setting.get();
    const port = this.d.port;
    return [
      ...(remote?.front === "edge"
        ? []
        : [
            `http://127.0.0.1:${port}`,
            `http://localhost:${port}`,
            `http://toyon.localhost:${port}`,
            ...(this.d.branded() ? ["http://toyon.localhost"] : []),
            // the Vite dev shell frames the same previews
            `http://127.0.0.1:${SHELL_DEV_PORT}`,
            `http://localhost:${SHELL_DEV_PORT}`,
            `http://[::1]:${SHELL_DEV_PORT}`,
          ]),
      ...(remote ? [`https://${remote.host}`] : []),
    ];
  }

  isOwn(origin: string): boolean {
    return this.own().includes(origin);
  }

  /** a loopback shell origin, as the daemon's own are: the second daemon on this machine, or the
   * Vite dev shell, framing or calling the first */
  isLoopback(origin: string): boolean {
    try {
      const u = new URL(origin);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      return isLoopbackHost(u.hostname);
    } catch {
      return false;
    }
  }
}
