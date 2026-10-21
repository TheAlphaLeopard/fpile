// ============================================================================
//  Azahar Standalone — v7 (WebGL2, minimal UI, URL ROM fetching)
//  ----------------------------------------------------------------------------
//  • Loads ROM from ?rom=<url> (cached in IndexedDB) or same-directory file
//  • Cross-origin isolation via coi-serviceworker.js (no COOP/COEP server config)
//  • WebGL2 GPU renderer (Shubin123 build, 768 MB → 4 GB memory)
//  • SDL2 handles keyboard input directly inside the WASM
//  • Autostart — no buttons, no menus, just the game
//
//  ROM sources (in priority order):
//    1. ?rom=https://example.com/game.3ds  → fetch from URL, cache in IndexedDB
//    2. ?rom=game.3ds                       → fetch from same directory
//    3. No ?rom → try rom.cci, rom.3ds, rom.cxi, game.cci, etc. in same dir
//
//  Caching: ROMs fetched from a URL are cached in IndexedDB keyed by URL.
//  Reloading the page with the same ?rom=<url> uses the cached data instantly.
// ============================================================================

(() => {
"use strict";

// ---- Configuration --------------------------------------------------------
const CANVAS_W = 400;
const CANVAS_H = 480;

const ROM_CANDIDATES = [
  "rom.cci", "rom.3ds", "rom.zcci",
  "rom.cxi", "rom.zcxi", "rom.app",
  "rom.cfa",
  "rom.3dsx", "rom.z3dsx",
  "rom.elf", "rom.axf",
  "game.cci", "game.3ds", "game.zcci",
  "game.cxi", "game.zcxi", "game.app",
  "game.cfa",
  "game.3dsx",
  "game.elf",
  "rom", "game"
];

const CIA_HEADER_SIZE = 0x2020;

// ---- DOM refs -------------------------------------------------------------
const $ = id => document.getElementById(id);
const boot = $("boot"), emu = $("emu"), canvas = $("canvas"),
      bar = $("bar").firstElementChild, statusEl = $("status");

let mod = null;

// ---- UI helpers -----------------------------------------------------------
function setStatus(msg) { statusEl.textContent = msg; }
function setProgress(pct) {
  bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
}

// ==========================================================================
//  IndexedDB ROM cache (keyed by URL, stores ArrayBuffer)
// ==========================================================================
const DB_NAME = "azahar-cache";
const STORE = "roms";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(url) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(url);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

async function cachePut(url, data) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(data, url);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch { return false; }
}

// ==========================================================================
//  STEP 1 — Cross-origin isolation via service worker
// ==========================================================================
async function ensureCrossOriginIsolated() {
  if (crossOriginIsolated) return true;
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers not supported. Use HTTPS or localhost.");
  }
  if (location.protocol === "file:") {
    throw new Error("file:// cannot register service workers. Serve via http(s)://");
  }
  setStatus("Enabling cross-origin isolation…");
  try {
    await navigator.serviceWorker.register("./coi-serviceworker.js", { scope: "./" });
  } catch (e) {
    throw new Error("SW registration failed: " + e.message);
  }
  setStatus("Reloading to activate…");
  await new Promise(r => setTimeout(r, 600));
  location.reload();
  return false;
}

// ==========================================================================
//  STEP 2 — Fetch the ROM (from URL with cache, or same directory)
// ==========================================================================
function isCiaFile(bytes) {
  if (bytes.byteLength < 4) return false;
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === CIA_HEADER_SIZE;
}

function isAbsoluteUrl(s) {
  return /^https?:\/\//i.test(s);
}

async function fetchRom() {
  const romParam = new URLSearchParams(location.search).get("rom");

  // Case 1: ?rom=<absolute URL> — fetch from URL with IndexedDB caching
  if (romParam && isAbsoluteUrl(romParam)) {
    // Check cache first
    const cached = await cacheGet(romParam);
    if (cached && cached.byteLength > 0) {
      const bytes = new Uint8Array(cached);
      const sizeMB = (cached.byteLength / 1048576).toFixed(1);
      setStatus("Using cached ROM (" + sizeMB + " MB)");
      if (isCiaFile(bytes)) {
        throw new Error("Cached file is a CIA container. Decrypt it first.");
      }
      return { name: "rom" + guessExt(romParam), data: bytes };
    }

    // Not cached — fetch from URL
    setStatus("Fetching ROM from URL…");
    setProgress(20);
    const res = await fetch(romParam, { cache: "no-store" });
    if (!res.ok) throw new Error("Fetch failed: HTTP " + res.status);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) throw new Error("Fetched ROM is empty");

    const bytes = new Uint8Array(buf);
    if (isCiaFile(bytes)) {
      throw new Error("This file is a CIA container. Decrypt it first.");
    }

    // Cache for next load
    setStatus("Caching ROM…");
    await cachePut(romParam, buf);

    const sizeMB = (buf.byteLength / 1048576).toFixed(1);
    setStatus("ROM loaded (" + sizeMB + " MB)");
    return { name: "rom" + guessExt(romParam), data: bytes };
  }

  // Case 2: ?rom=<filename> — fetch from same directory
  const candidates = romParam ? [romParam] : ROM_CANDIDATES;
  for (const name of candidates) {
    setStatus("Looking for " + name + " …");
    try {
      const res = await fetch("./" + name, { cache: "no-store" });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) continue;
      const bytes = new Uint8Array(buf);
      if (isCiaFile(bytes)) {
        throw new Error(name + " is a CIA container. Decrypt it first.");
      }
      const sizeMB = (buf.byteLength / 1048576).toFixed(1);
      setStatus("Found " + name + " (" + sizeMB + " MB)");
      return { name: name, data: bytes };
    } catch (e) {
      if (e.message.includes("CIA")) throw e;
      continue;
    }
  }
  throw new Error(
    "No ROM found. Place rom.cci in this folder, or use ?rom=<url-or-filename>"
  );
}

function guessExt(name) {
  const m = name.match(/(\.[^.]+)$/);
  return m ? m[1] : ".cci";
}

// ==========================================================================
//  STEP 3 — Load the WASM module (classic script, sets window.Module)
// ==========================================================================
function loadWasmScript() {
  return new Promise((resolve, reject) => {
    window.Module = window.Module || {};
    window.Module.canvas = canvas;
    window.Module.print = () => {};
    window.Module.printErr = () => {};

    window.Module.onRuntimeInitialized = () => {
      resolve(window.Module);
    };

    const script = document.createElement("script");
    script.src = "./azahar_webgl2.js";
    script.onload = () => {
      if (window.Module && window.Module.calledRun) {
        resolve(window.Module);
      }
    };
    script.onerror = () => reject(new Error("Failed to load azahar_webgl2.js"));
    document.head.appendChild(script);

    setTimeout(() => {
      if (window.Module && window.Module.calledRun) resolve(window.Module);
    }, 30000);
  });
}

async function initModule() {
  if (mod) return mod;
  setStatus("Loading WebGL2 engine…");
  setProgress(50);
  mod = await loadWasmScript();

  setStatus("Initializing renderer…");
  setProgress(70);
  const result = mod._azahar_init();
  if (result !== 0) {
    if (result === -7) {
      throw new Error("WebGL2 not available. Try Chrome with hardware acceleration on.");
    }
    throw new Error("Init failed (code " + result + ")");
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    setTimeout(() => location.reload(), 500);
  }, { once: true });

  return mod;
}

// ==========================================================================
//  STEP 4 — Load the ROM into the emulator
// ==========================================================================
async function loadRom(rom) {
  setStatus("Loading ROM into emulator…");
  setProgress(85);
  const romPath = "rom" + rom.name.match(/\.[^.]+$/)[0];
  mod.FS.writeFile(romPath, rom.data, { canOwn: true });

  const result = mod.ccall("azahar_load_rom", "number", ["string"], [romPath]);
  if (result === 0) return;
  if (result === -8) throw new Error("ROM is encrypted. Use a decrypted dump.");
  if (result === -4) throw new Error("Could not open ROM file.");
  throw new Error("azahar_load_rom failed (code " + result + ")");
}

// ==========================================================================
//  STEP 5 — Main loop
// ==========================================================================
function startLoop() {
  const step = mod._azahar_step_frame;
  (function loop() {
    step();
    requestAnimationFrame(loop);
  })();
}

// ==========================================================================
//  Main flow
// ==========================================================================
async function main() {
  try {
    setProgress(5);
    const ok = await ensureCrossOriginIsolated();
    if (!ok) return;

    setProgress(15);
    const rom = await fetchRom();

    setProgress(60);
    await initModule();

    setProgress(85);
    await loadRom(rom);

    setProgress(100);
    setStatus("Starting…");

    // Hide boot screen, show canvas, start
    boot.classList.add("hidden");
    emu.classList.add("on");
    startLoop();
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e));
    setProgress(0);
  }
}

main();

})();
