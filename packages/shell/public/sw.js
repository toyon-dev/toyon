// Minimal service worker for PWA installability. Network-only on purpose:
// the daemon is local, caching would only cause staleness.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
