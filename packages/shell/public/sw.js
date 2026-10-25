// What the worker keeps, and when it answers. A daemon that answers, with whatever status, is
// always left to answer: the worker steps in only for a request that fails at the network.
//
// On a loopback origin the daemon is local and nothing of the shell is cached: a cached index.html
// would boot an asset graph the daemon no longer has, and the one thing kept is the page for when
// nothing answers at all. The shortcut Chromium makes for the installed app opens this origin
// directly and has no way to start a daemon, so without this the browser's own "refused to
// connect" page is what a person sees, and it never says Toyon or what to do.
//
// On any other origin (a phone over the tailnet, a cloud box) nothing here can start a daemon,
// and the shell itself is what to show: it opens on what it last knew of the machine (state/
// recall.ts) and says how old that is. So off loopback the worker keeps the last shell this
// origin served, the index with the asset graph it names, replaced whole when the index changes,
// and serves it for a navigation the network fails. Chunks the index never names (the editor, the
// terminal, loaded on first use) are kept as they are first fetched, so a page served from here
// can still reach them.
const OFFLINE = "toyon-offline";
const PAGE = "/offline.html";
const SHELL = "toyon-shell";
/** the index, under one key: the shell is one page, whatever path was navigated to */
const INDEX = "/";

// the daemon's own test for a loopback name (isLoopbackHost in the shared package), which a worker
// cannot import
const loopback = (h) => h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]";
const here = loopback(self.location.hostname);

// Files shared into the installed app from a phone's share sheet (the manifest's share_target)
// arrive as a form POST to this path, which the worker takes in: the files go into a cache of
// their own and the browser is sent on to the shell, which reads them out (app/share.ts) and
// attaches them. The daemon answers the same POST with the same redirect, for a browser whose
// worker is not yet in charge; the files are lost then, the shell says nothing, and the next
// share works.
const SHARE = "/share";
const SHARED = "toyon-shared";
const SHARED_NAME = "x-toyon-name";

async function takeShare(request) {
  const data = await request.formData();
  const cache = await caches.open(SHARED);
  let n = 0;
  for (const file of data.getAll("files")) {
    if (!(file instanceof File)) continue;
    // a header holds bytes alone; the shell decodes the name on the way out
    const headers = { "content-type": file.type || "application/octet-stream", [SHARED_NAME]: encodeURIComponent(file.name) };
    await cache.put(`${SHARE}/${n++}`, new Response(file, { headers }));
  }
  return Response.redirect("/", 303);
}

// the copy shown is the one the daemon served last, not the one this worker installed with: a
// change to the page reaches the cache on the next navigation that gets through
const refresh = () => caches.open(OFFLINE).then((cache) => cache.add(PAGE));

/** the same-origin assets an index names, in order: its scripts, its styles and its preloads */
const assetsOf = (html) => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);

/** The shell the daemon just served, kept when its index is not the one the cache holds.
 * The graph goes in before the index that names it, so a shell served from here never names a
 * chunk it lacks; what the old build had and this one does not goes, lazy chunks included, since
 * the cache is one build and a chunk still in use comes back on its first fetch. */
async function keepShell(res) {
  const html = await res.text();
  const assets = assetsOf(html);
  if (assets.length === 0) return;
  const cache = await caches.open(SHELL);
  // the index itself is what is compared: a build that changed only the page's inline script
  // names the same assets and is still a new build
  const kept = await cache.match(INDEX);
  if (kept && (await kept.text()) === html) return;
  await cache.addAll(assets);
  await cache.put(INDEX, new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/assets/") && !assets.includes(path)) await cache.delete(req);
  }
}

/** a navigation: the daemon's answer, or when the network fails, the kept shell off loopback and
 * the not-running page otherwise. The not-running page itself is never answered with the shell,
 * since a page that asks for it is one the shell sent there. */
async function navigate(e) {
  try {
    const res = await fetch(e.request);
    // a daemon serving the shell again is the moment to pick up its page and its build; a
    // failure here is nothing the navigation needs
    e.waitUntil(Promise.all([refresh(), here ? null : keepShell(res.clone())]).catch(() => {}));
    return res;
  } catch {
    if (!here && new URL(e.request.url).pathname !== PAGE) {
      const shell = await (await caches.open(SHELL)).match(INDEX);
      if (shell) return shell;
    }
    return (await caches.match(PAGE)) ?? Response.error();
  }
}

/** an asset off loopback: the network's copy, kept as it passes; the kept one when the network
 * fails, which is how a page served from the kept index finds the chunks it imports later */
async function asset(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const copy = res.clone();
      caches.open(SHELL).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return res;
  } catch {
    return (await (await caches.open(SHELL)).match(request)) ?? Response.error();
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil(refresh().then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.mode === "navigate") {
    if (e.request.method === "POST" && url.pathname === SHARE) {
      e.respondWith(takeShare(e.request));
      return;
    }
    e.respondWith(navigate(e));
    return;
  }
  if (!here && url.origin === self.location.origin && url.pathname.startsWith("/assets/")) e.respondWith(asset(e.request));
});
