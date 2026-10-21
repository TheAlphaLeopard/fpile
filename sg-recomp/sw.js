/*
 * ppsspp web shell — service worker: cross-origin isolation shim for static hosts
 * --------------------------------------------------------------------------------
 * The PPSSPP wasm build uses shared wasm memory + pthreads, which the
 * browser only grants to cross-origin isolated pages:
 *   COOP: same-origin + COEP: require-corp
 * Static hosts (GitHub Pages, Live Server…) can't set these, so this
 * worker injects them on NAVIGATION responses only, then the shell
 * reloads once (app.js → ensureIsolated()).
 *
 * interception policy — deliberately tiny:
 *   • navigations     → network-first, rebuilt with COI headers (html is small)
 *   • /emulator/*     → cache-first (the only heavy thing: ~64 mb bundle)
 *   • everything else → passthrough, no respondWith at all.
 * shell files (app.js/app.css/…) are never cached here: they are small,
 * local, and keeping them out of the worker means they can never go stale.
 */

const CACHE = "sg-shell-v3";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* Worker-script loads are NOT intercepted — they must pass to the
     network untouched or dedicated-worker script loading breaks. */
  if (req.destination === "worker" || req.destination === "sharedworker") return;

  /* Emulator bundle: cache-first + isolation headers. */
  if (url.pathname.includes("/emulator/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreVary: true });
      if (hit) return await wrapCoi(hit);
      const resp = await fetch(req, { cache: "reload" });
      if (resp.ok) await cache.put(req, resp.clone());
      return await wrapCoi(resp);
    })());
    return;
  }

  /* Navigations: network-first, wrapped with isolation headers. */
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "reload" });
        return await wrapCoi(fresh);
      } catch (e) {
        const cache = await caches.open(CACHE);
        const fallback = await cache.match("./index.html");
        if (fallback) return await wrapCoi(fallback);
        return new Response("<p>ppsspp web: offline and no cached shell.</p>", {
          status: 504,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    })());
  }
  /* everything else: plain passthrough (browser handles it natively) */
});

/* only navigations get rebuilt (their bodies are small html documents) */
async function wrapCoi(resp) {
  const buf = await resp.clone().arrayBuffer();
  const headers = new Headers(resp.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cache-Control", "no-cache");
  return new Response(buf, { status: resp.status, statusText: resp.statusText, headers });
}
