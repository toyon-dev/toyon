import type { Store } from "../state/context.tsx";
import { attachAny, dropBox } from "../surfaces/chat/useIntake.ts";

/**
 * Files shared into the installed app from a phone's share sheet. The manifest names Toyon a share
 * target, so a screenshot, a photo or a file in any app lists Toyon beside the messengers; the
 * share is a form POST to /share, which the service worker (public/sw.js) takes in: it puts the
 * files in a cache of their own and sends the browser on to the shell. This reads them out of that
 * cache as the page boots and attaches them where a drop on the chat would go, so there is no
 * picker and no camera sheet between the share and the chip.
 *
 * The cache's name and the header the file's name rides in are the worker's; the two files change
 * together.
 */
const SHARED = "toyon-shared";
const SHARED_NAME = "x-toyon-name";

/** the files the worker put by for this page, in the order they were shared, and the cache gone.
 * Nothing in a browser that has no cache storage (a page that is not a secure context). */
export async function sharedFiles(storage: CacheStorage | undefined = globalThis.caches): Promise<File[]> {
  try {
    if (!storage || !(await storage.has(SHARED))) return [];
    const cache = await storage.open(SHARED);
    const out: File[] = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res) continue;
      const name = decodeURIComponent(res.headers.get(SHARED_NAME) ?? "") || "shared";
      // the bare type, as a File carries it: a runtime may have added a charset to the header
      const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      out.push(new File([await res.blob()], name, { type }));
    }
    await storage.delete(SHARED);
    return out;
  } catch {
    // a storage that refuses (a private window): nothing was shared that this page can reach
    return [];
  }
}

/** the box a drop on the chat would go into, once `ready` says the page is there: the daemon's
 * hello has put a worktree on screen, or a row has been tapped */
function untilBox(store: Store, ready: () => boolean = () => true): Promise<string> {
  const boxNow = () => (ready() ? dropBox(store) : null);
  return new Promise((resolve) => {
    const now = boxNow();
    if (now) return resolve(now);
    const stop = store.subscribe(() => {
      const box = boxNow();
      if (!box) return;
      stop();
      resolve(box);
    });
  });
}

/** what the bar says over the list while a share waits for its chat */
export function sharingLine(files: readonly File[]): string {
  const [first] = files;
  if (files.length === 1 && first) return `pick a chat for ${first.name}`;
  const noun = files.every((f) => f.type.startsWith("image/")) ? "images" : "files";
  return `pick a chat for ${files.length} ${noun}`;
}

/** What was shared into the app, attached in a composer: pictures as images, the rest as files,
 * the way a drop sorts them. On the desk that is the composer on screen, which is in view. A phone
 * lands on its list instead, the bar saying what waits, and the row tapped is the chat it goes
 * to: the app was opened from another app, and whichever chat was open last is not a choice. */
export async function takeShared(store: Store, storage?: CacheStorage): Promise<void> {
  const files = await sharedFiles(storage);
  if (files.length === 0) return;
  if (store.getState().frame !== "phone") {
    attachAny(store, await untilBox(store), files);
    return;
  }
  store.dispatch({ a: "screen", to: "home" });
  store.dispatch({ a: "sharing", v: sharingLine(files) });
  const box = await untilBox(store, () => store.getState().screen !== "home");
  store.dispatch({ a: "sharing", v: null });
  attachAny(store, box, files);
}
