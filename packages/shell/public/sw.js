// The daemon is local, so nothing the shell loads is cached: a cached index.html would boot an
// asset graph the daemon no longer has. The one thing kept is the page for when nothing answers at
// all. The shortcut Chromium makes for the installed app opens this origin directly and has no way
// to start a daemon, so without this the browser's own "refused to connect" page is what a person
// sees, and it never says Toyon or what to do. The worker steps in for a navigation alone, and only
// one that fails at the network: a daemon that answers, with whatever status, is left to answer.
const CACHE = "toyon-offline";
const PAGE = "/offline.html";

// the copy shown is the one the daemon served last, not the one this worker installed with: a
// change to the page reaches the cache on the next navigation that gets through
const refresh = () => caches.open(CACHE).then((cache) => cache.add(PAGE));

self.addEventListener("install", (e) => {
  e.waitUntil(refresh().then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
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
