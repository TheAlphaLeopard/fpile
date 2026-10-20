// coi-serviceworker.js — fpile edition
// ─────────────────────────────────────────────────────────────────────────────
// 1. Cross-Origin Isolation (MIT, based on gzuidhof/coi-serviceworker):
//    stamps COOP/COEP onto responses so SharedArrayBuffer + wasm threads work.
//      • page documents   → COEP: credentialless (keeps cross-origin CDN assets
//        like EmulatorJS/Ruffle/fonts loading without CORP headers)
//      • virtual core docs → COEP: require-corp  (full isolation for jam cores)
// 2. Virtual jam-core hosting: serves unpacked core-.jam files ("cores")
//    under /.../__jamcore__/<coreId>/<path> from the Cache API. The page
//    installs entries (caches.open("jamcore-<coreId>").put(...)); this worker
//    only serves them. This gives cores a real document URL with a real
//    location.search (?rom=...) and COI headers, which blob:/srcdoc cannot.
// Fixed: skips blob:/data:/file: URLs so file uploads are not intercepted.

const PAGE_COI_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless"
};

const CORE_COI_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "cross-origin"
};

function coiType(headers) {
    const coop = headers.get("Cross-Origin-Opener-Policy");
    const coep = headers.get("Cross-Origin-Embedder-Policy");
    if (coop === "same-origin" && (coep === "credentialless" || coep === "require-corp")) return "core";
    return null;
}

/* Stream an OPFS file (installed by the page) as a Response. getFile() works
   inside service workers; the Blob-backed body is read lazily off disk, so
   RAM stays bounded for multi-GB ROMs.                                     */
async function opfsRomResponse(opfsPath, declaredSize) {
    const root = await navigator.storage.getDirectory();
    const segs = String(opfsPath).split("/").filter(Boolean);
    const fileName = segs.pop();
    let dir = root;
    for (const s of segs) dir = await dir.getDirectoryHandle(s);
    const fh = await dir.getFileHandle(fileName);
    const file = await fh.getFile();
    return new Response(file, {
        status: 200,
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(declaredSize || file.size)
        }
    });
}

function stampCoi(res, headers) {
    const nh = new Headers(res.headers);
    for (const k in headers) nh.set(k, headers[k]);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: nh });
}

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", function (event) {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;

    // ── virtual jam-core hosting: /<any-enough-path>/__jamcore__/<coreId>/<path> ──
    const parts = url.pathname.split("/");
    const jIdx = parts.indexOf("__jamcore__");
    if (jIdx !== -1 && parts[jIdx + 1]) {
        event.respondWith((async function () {
            try {
                const coreId = parts[jIdx + 1];
                const rel = parts.slice(jIdx + 2).join("/") || "index.html";
                const cache = await caches.open("jamcore-" + coreId);
                // match ignoring the query string: core documents navigate with
                // ?rom=… parameters, cache keys are stored query-less
                const hit = await cache.match(url.origin + url.pathname);
                if (!hit) {
                    return new Response("jamcore: no '" + rel + "' in core '" + coreId + "'",
                        { status: 404, headers: { "Content-Type": "text/plain" } });
                }
                // __rom__ entries may be raw bytes or a pointer to an OPFS-backed ROM
                // ({opfs:"fpile-roms/<name>", size}) — Cache API entries have a size
                // limit, so real (hundreds-of-MB) ROMs are streamed from OPFS instead.
                const rct = hit.headers.get("Content-Type") || "";
                if (rel.startsWith("__rom__/") && rct.indexOf("json") !== -1) {
                    const meta = await hit.json();
                    let resp;
                    try { resp = await opfsRomResponse(meta.opfs, meta.size); }
                    catch (e) {
                        return new Response("jamcore: ROM backing missing (" + meta.opfs + ") — relaunch this game to re-install it: " + String(e),
                            { status: 500, headers: { "Content-Type": "text/plain" } });
                    }
                    const nh = new Headers(resp.headers);
                    for (const k in CORE_COI_HEADERS) nh.set(k, CORE_COI_HEADERS[k]);
                    nh.set("Cache-Control", "no-store");
                    return new Response(resp.body, { status: 200, statusText: "OK", headers: nh });
                }
                const nh = new Headers(hit.headers);
                for (const k in CORE_COI_HEADERS) nh.set(k, CORE_COI_HEADERS[k]);
                nh.set("Cache-Control", "no-store");
                return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: nh });
            } catch (e) {
                return new Response("jamcore error: " + String(e), { status: 500, headers: { "Content-Type": "text/plain" } });
            }
        })());
        return;
    }

    // ── plain COI stamping for everything else in scope ──
    if (req.mode === "navigate" || req.mode === "same-origin" || req.mode === "cors") {
        event.respondWith((async function () {
            try {
                const res = await fetch(req);
                if (coiType(res.headers)) return res;                 // already COI'd — pass through
                if (res.type === "opaque" || res.status === 0) return res; // unstampable
                return stampCoi(res, PAGE_COI_HEADERS);               // credentialless keeps CDNs working
            } catch (e) {
                return Response.error();
            }
        })());
    }
});
