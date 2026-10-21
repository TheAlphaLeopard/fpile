/* cores/psp.js — fpile system-core driver: PSP (PPSSPP standalone).
   Fpile evaluates this file once at load. The driver owns ALL its core
   know-how; the page never hardcodes core specifics:

     window.fpileDrivers['psp'] = {
         name: 'psp',                       // cache id: jamcore-psp, hosted at
                                            // ./__jamcore__/psp/<file> by coi-serviceworker.js
         exts: [...],                       // ROM extensions this driver boots
         ver: '1',                          // bump to force a re-install of the files
         install(ctx) -> Promise            // fetch every file the core needs from its
                                            // folder and put it into the virtual host
     };

   ctx = { id, url(rel), openCache(), reset(), setStatus(msg), mime(path) } —
   supplied by the page (which also handles SW registration, COI headers and
   ROM storage in OPFS behind __rom__/<file> pointer entries). The core
   folder itself is never modified.                                          */
(function () {
    'use strict';

    var NAME = 'psp';
    var TITLE = 'PSP';
    var SRC = 'sg-recomp/';         // folder beside the fpile page
    var VER = '1';

    /* Everything the shell requests relative to its own document: the boot
       page and its assets, app code, emulator build + PPSSPPSDL blobs, and
       sw.js (only registers when the folder is served non-isolated).         */
    var FILES = [
        'index.html',
        'app.js',
        'app.css',
        'sw.js',
        'build-info.json',
        'manifest.webmanifest',
        'assets/ppsspp-logo.png',
        'assets/ppsspp-logo-192.png',
        'assets/ppsspp-logo-512.png',
        'emulator/PPSSPPSDL.js',
        'emulator/PPSSPPSDL.wasm',
        'emulator/PPSSPPSDL.data'
    ];

    window.fpileDrivers = window.fpileDrivers || {};
    window.fpileDrivers[NAME] = {
        name: NAME,
        exts: ['psp', 'cso', 'pbp', 'prx', 'iso', 'chd'],
        ver: VER,
        install: async function (ctx) {
            var cache = await ctx.openCache();
            var fresh = false;
            try {
                var v = await cache.match(ctx.url('__driver__/ver'));
                fresh = !!v && (await v.text()) === String(VER) &&
                        !!(await cache.match(ctx.url('index.html')));
            } catch (e) {}
            if (fresh) return;                // same version already hosted
            try { await ctx.reset(); } catch (e) {}   // stale or half-installed
            cache = await ctx.openCache();    // reopen AFTER the reset — a cache
                                              // handle kept across delete() detaches
                                              // from storage and its puts are lost
            ctx.setStatus('Fetching ' + TITLE + ' core files…');
            var puts = [];
            var fetched = 0;
            for (var i = 0; i < FILES.length; i++) {
                var rel = FILES[i];
                var res = await fetch(new URL(rel, new URL(SRC, location.href)).href, { cache: 'no-store' });
                if (!res.ok) throw new Error(NAME + ' core: HTTP ' + res.status + ' for ' + SRC + rel);
                var data = new Uint8Array(await res.arrayBuffer());
                fetched += data.length;
                puts.push(cache.put(new Request(ctx.url(rel)),
                    new Response(data, { headers: { 'Content-Type': ctx.mime(rel) } })));
            }
            puts.push(cache.put(new Request(ctx.url('__driver__/ver')),
                new Response(String(VER), { headers: { 'Content-Type': 'text/plain' } })));
            try {
                await Promise.all(puts);
            } catch (err) {
                try { await ctx.reset(); } catch (e) {}   // no half-installed core pretends to be fresh
                if (err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message || err))))
                    throw new Error('storage full while installing the ' + TITLE + ' core (' + (fetched / 1048576).toFixed(0) + ' MB) — free disk space or clear this site\'s stored data, then retry');
                throw err;
            }
        }
    };
})();
