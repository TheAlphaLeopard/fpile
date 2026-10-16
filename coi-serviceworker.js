// coi-serviceworker.js — injects COOP/COEP headers (MIT, gzuidhof)
// Fixed: skips blob:/data:/file: URLs so file uploads are not intercepted.

const COI_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin"
};

function hasCoopCoep(h) {
    return h.get("Cross-Origin-Opener-Policy") === "same-origin"
        && h.get("Cross-Origin-Embedder-Policy") === "require-corp";
}

self.addEventListener("install", function() { self.skipWaiting(); });
self.addEventListener("activate", function(e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", function(event) {
    var req = event.request;
    if (req.method !== "GET") return;

    // Skip blob:, data:, and file: URLs — they are used by file uploads
    // and must not be intercepted or COI headers will break them.
    var u = req.url;
    if (u.indexOf("blob:") === 0 || u.indexOf("data:") === 0 || u.indexOf("file:") === 0) return;

    if (req.mode === "navigate" || req.mode === "same-origin" || req.mode === "cors") {
        event.respondWith((async function() {
            try {
                var res = await fetch(req);
                if (hasCoopCoep(res.headers)) return res;
                if (res.type === "opaque" || res.status === 0) return res;
                var nh = new Headers(res.headers);
                for (var k in COI_HEADERS) nh.set(k, COI_HEADERS[k]);
                return new Response(res.body, {
                    status: res.status,
                    statusText: res.statusText,
                    headers: nh
                });
            } catch (e) {
                return Response.error();
            }
        })());
    }
});
