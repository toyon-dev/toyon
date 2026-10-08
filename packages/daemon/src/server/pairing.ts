// The routes for pairing, on the daemon's listener: a device knocking and polling its knock, the
// answers from whoever holds the token, the tailnet's phones and machines, the public name turned
// on or off, and the machines handed to this daemon. Transport only: each parses, calls a service,
// shapes the reply. The knock and its poll take no token, since they are how a device without one
// asks; everything else sits behind the bearer.

import {
  isShellOrigin,
  isTailnetName,
  type Knock,
  type KnockState,
  type Remote,
  type RemoteView,
  type TailnetMachine,
  type TailnetPhone,
} from "@toyon/shared";
import { UserError } from "../core/errors.ts";
import type { Knocks } from "../core/knocks.ts";
import type { Origins } from "../core/origins.ts";
import type { Door } from "../core/remote.ts";
import type { RemoteSwitch } from "../core/remoteSwitch.ts";
import type { Tailnet } from "../core/tailnet.ts";

export interface PairingDeps {
  /** the token: what a let-in hands over */
  token: string;
  /** whether the request carries the token as a bearer */
  authed: (req: Request) => boolean;
  remote: () => Remote | null;
  /** the preview grant cookie for a page on the public name, as /bootstrap sets it */
  grantCookie: (remote: Remote) => string;
  origins: Pick<Origins, "isOwn" | "isLoopback">;
  knocks: Knocks;
  /** a knock was just let in, from a page on `from` (null for a page this machine served) */
  onLetIn: (from: string | null) => void;
  tailnet: Pick<Tailnet, "phones" | "machines" | "isToyon">;
  remoteSwitch: Pick<RemoteSwitch, "turnOn" | "use" | "turnOff">;
  /** list another machine for every shell this daemon serves; a UserError says why not */
  addMachine: (origin: string, token: string) => void;
}

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { headers: { ...NO_STORE, ...headers } });
const unauthorized = () => new Response("unauthorized", { status: 401 });

/** the knock a `GET /knock/<id>` asks after, or null for any other path */
export const knockPolled = (url: URL): string | null => url.pathname.match(/^\/knock\/([A-Za-z0-9_-]+)$/)?.[1] ?? null;

/** whether a path is one any origin may call: the way a device without a token asks */
export const openToAnyOrigin = (url: URL): boolean => url.pathname === "/knock" || knockPolled(url) !== null;

export function pairingRoutes(d: PairingDeps) {
  return async (req: Request, url: URL, door: Exclude<Door, { kind: "refused" }>): Promise<Response | undefined> => {
    const remote = d.remote();
    /** the request came through the front for the shell's own name */
    const front = door.kind === "shell";

    // A device that has no token asks to be let in. Through the front for the public name (a phone
    // that opened the address, a desk elsewhere adding this machine) or on the loopback name (a
    // second daemon's shell on this machine); never a page under a preview name. The origin it
    // names is kept with the knock so the card can say where it came from, and so the page there
    // is answered across origins once it is in. A knock from one of this daemon's own origins is
    // a device here. Through a front the device's own address is what the front said; on the
    // loopback name there is no front and nobody to count.
    //
    // A knock takes no credential, so any web page the person visits could place one and hope
    // for a careless yes. Two rules keep that to pages that are Toyon's: on the loopback name
    // only this machine's own origins and other loopback ones (a second daemon here) knock,
    // since a page from the internet has no business there; and a page from elsewhere is asked
    // at its own /health first, which a Toyon answers and a stray site does not.
    if (url.pathname === "/knock" && req.method === "POST") {
      const from = req.headers.get("origin");
      const own = from === null || d.origins.isOwn(from);
      const placed = front || (from !== null && d.origins.isLoopback(from));
      if (!own && (!isShellOrigin(from) || !placed || !(await d.tailnet.isToyon(from)))) {
        return new Response("not a Toyon page", { status: 403 });
      }
      const knocked = d.knocks.knock(own ? null : from, door.kind === "shell" ? door.client : null);
      if (!knocked) return new Response("too many devices are waiting to be let in", { status: 429 });
      return json(knocked);
    }

    // The same device, asking what became of its knock. A let-in answer carries the token, once,
    // and through the front the preview grant with it as /bootstrap gives one; a knock that was
    // answered, timed out or never made is not found, and the page asks again.
    const polled = knockPolled(url);
    if (polled !== null && req.method === "GET") {
      const state = d.knocks.poll(polled);
      if (state === null) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = {};
      if (state === "let-in" && remote && front) headers["set-cookie"] = d.grantCookie(remote);
      const body: KnockState = state === "let-in" ? { state, token: d.token } : { state };
      return json(body, headers);
    }

    if (!url.pathname.match(/^\/(knocks|knock\/[A-Za-z0-9_-]+\/answer|phones|tailnet|remote|machines)$/))
      return undefined;
    if (!d.authed(req)) return unauthorized();

    // What waits, for `toyon pair` in a terminal; the shells hear every change on their sockets.
    if (url.pathname === "/knocks" && req.method === "GET") {
      const body: Knock[] = d.knocks.pending();
      return json(body);
    }

    // The answer. A yes is recorded before the knock is answered, so the one `knocks` frame the
    // answer sends already carries what the yes changed.
    const answered = url.pathname.match(/^\/knock\/([A-Za-z0-9_-]+)\/answer$/)?.[1];
    if (answered !== undefined && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { letIn?: unknown };
      if (typeof body.letIn !== "boolean") return new Response("letIn must be true or false", { status: 400 });
      const knock = d.knocks.pending().find((k) => k.id === answered);
      if (!knock) return new Response("that device is no longer waiting", { status: 404 });
      if (body.letIn) d.onLetIn(knock.from);
      d.knocks.answer(answered, body.letIn);
      return new Response(null, { status: 204 });
    }

    // Whether a phone could open the address at all, for the card that shows it. A tailnet name
    // resolves only on a connected device, and a phone that is not one never loads a page of ours.
    if (url.pathname === "/phones" && req.method === "GET") {
      const body: TailnetPhone[] | null = remote && isTailnetName(remote.host) ? await d.tailnet.phones() : null;
      return json(body);
    }

    // The other machines on the tailnet, for the add-machine card: which of them answer as a
    // Toyon with a name is what the card lists, and the rest is one line about `toyon remote`.
    if (url.pathname === "/tailnet" && req.method === "GET") {
      const body: TailnetMachine[] | null = await d.tailnet.machines();
      return json(body);
    }

    // Remote access turned on or off while running: `toyon remote`, `toyon pair` on a box, and the
    // card's "turn on". A name on the tailnet is a door to this machine, hence the token.
    if (url.pathname === "/remote" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        tailscale?: unknown;
        off?: unknown;
        host?: unknown;
        previews?: unknown;
      };
      try {
        if (body.tailscale === true) return json({ remote: await d.remoteSwitch.turnOn() });
        if (body.off === true) {
          await d.remoteSwitch.turnOff();
          return json({ remote: null });
        }
        if (typeof body.host === "string" && typeof body.previews === "string") {
          const view: RemoteView = { host: body.host, previews: body.previews };
          return json({ remote: d.remoteSwitch.use(view) });
        }
        return new Response("say tailscale, off, or a host and its previews", { status: 400 });
      } catch (e) {
        if (e instanceof UserError) return new Response(e.message, { status: 409 });
        throw e;
      }
    }

    // Another machine, handed to this daemon with its token: by the CLI on this box after a deploy,
    // or by a shell this daemon serves once that machine let it in. The daemon keeps the one list,
    // and every shell it serves gets it in hello, so a pairing is done once per machine.
    if (url.pathname === "/machines" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { origin?: unknown; token?: unknown };
      if (typeof body.origin !== "string" || typeof body.token !== "string") {
        return new Response("origin and token", { status: 400 });
      }
      try {
        d.addMachine(body.origin, body.token);
      } catch (e) {
        if (e instanceof UserError) return new Response(e.message, { status: 400 });
        throw e;
      }
      return new Response(null, { status: 204 });
    }
    return undefined;
  };
}
