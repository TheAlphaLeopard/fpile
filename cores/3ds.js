/* cores/3ds.js — fpile system-core driver: 3DS (Azahar standalone).
   Fpile evaluates this file once at load. The driver owns ALL its core
   know-how; the page never hardcodes core specifics:

     window.fpileDrivers['3ds'] = {
         name: '3ds',                       // cache id: jamcore-3ds, hosted at
                                            // ./__jamcore__/3ds/<file> by coi-serviceworker.js
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

    var NAME = '3ds';
    var TITLE = '3DS';
    var SRC = 'azahar-standalone/'; // folder beside the fpile page
    var VER = '1';

    /* Everything the shell requests relative to its own document. README is
       documentation only — purposefully not packaged.                        */
    var FILES = [
        'index.html',
        'app.js',
        'coi-serviceworker.js',
        'azahar_webgl2.js',
        'azahar_webgl2.wasm'
    ];

    window.fpileDrivers = window.fpileDrivers || {};
    window.fpileDrivers[NAME] = {
        name: NAME,
        exts: ['3ds', 'cci', 'zcci', 'cxi', 'zcxi', 'app', 'cfa', '3dsx', 'z3dsx'],
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
