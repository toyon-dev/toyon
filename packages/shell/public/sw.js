// The daemon is local, so nothing the shell loads is cached: a cached index.html would boot an
// asset graph the daemon no longer has. The one thing kept is the page for when nothing answers at
// all. The shortcut Chromium makes for the installed app opens this origin directly and has no way
// to start a daemon, so without this the browser's own "refused to connect" page is what a person
// sees, and it never says Toyon or what to do. The worker steps in for a navigation alone, and only
// one that fails at the network: a daemon that answers, with whatever status, is left to answer.
const CACHE = "toyon-offline";
const PAGE = "/offline.html";

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
const refresh = () => caches.open(CACHE).then((cache) => cache.add(PAGE));

self.addEventListener("install", (e) => {
  e.waitUntil(refresh().then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  if (e.request.method === "POST" && new URL(e.request.url).pathname === SHARE) {
    e.respondWith(takeShare(e.request));
    return;
  }
  e.respondWith(
    (async () => {
      try {
        const res = await fetch(e.request);
        // a daemon serving the shell again is the moment to pick up its page; a failure here is
        // nothing the navigation needs
        e.waitUntil(refresh().catch(() => {}));
        return res;
      } catch {
        return (await caches.match(PAGE)) ?? Response.error();
      }
    })(),
  );
});
