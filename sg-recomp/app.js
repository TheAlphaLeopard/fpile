/*
 * sg-recomp shell runtime
 * -----------------------
 * Self-contained PPSSPP-WASM shell: auto-boots the bundled game, mirrors saves
 * through OPFS, and renders a minimal island dock UI.
 *
 * Integration contract adapted from root-hunter/ppsspp-web (wasm branch),
 * public/ppsspp-runtime.js — GPL-2.0-or-later (SPDX header preserved by the
 * project's LICENSES.md). This file remains GPL-2.0-or-later for consistency.
 */

(() => {
  "use strict";

  /* ── Constants ──────────────────────────────────────────────────── */

  const BUILD_DIR = "emulator/";
  const VIRTUAL_GAME_DIR = "/games";
  const VIRTUAL_ASSETS = "/emsdk/upstream/emscripten/cache/sysroot/share/ppsspp/assets";
  const GAME_FILE_ACCEPT = ".iso,.cso,.chd,.pbp,.elf,.prx";
  const GAME_FILE_EXT_RE = /\.(iso|cso|chd|pbp|elf|prx)$/i;

  const OPFS_ROOT_DIR = "sg-recomp";
  const OPFS_PERSIST_DIR = "persist";
  const OPFS_GAMES_DIR = "games";
  const OPFS_GAME_META_DIR = "game-meta";
  const PERSIST_SYNC_MS = 30000;

  // PPSSPP writes config+saves to $HOME/.config/ppsspp on Linux/Emscripten.
  const PERSIST_ROOTS = ["/home/web_user/.config/ppsspp", "/root/.config/ppsspp"];

  const WEB_NATIVE_TIMING_CONFIG = [
    ["General", "ForceLagSync2", "True"],
    ["Graphics", "DisplayRefreshRate", "60"],
    ["Graphics", "FrameRate", "0"],
    ["Graphics", "FrameRate2", "-1"],
    ["Graphics", "FrameSkip", "0"],
    ["Graphics", "AutoFrameSkip", "False"],
    ["Graphics", "VerticalSync", "True"],
    ["Graphics", "LowLatencyPresent", "False"],
    ["Sound", "Enable", "True"],
    ["Sound", "ExtraAudioBuffering", "False"],
    ["Sound", "AudioBufferSize", "1024"],
    ["Sound", "FillAudioGaps", "True"],
    ["Sound", "AudioSyncMode", "0"],
  ];
  const WEB_STABILITY_CONFIG = [
    ["General", "IgnoreBadMemAccess", "True"],
    ["CPU", "FastMemoryAccess", "True"],
  ];
  const MOBILE_TOUCH_CONFIG = [    ["General", "UIScaleFactor", "3"],
    ["Control", "ShowTouchControls", "True"],
    ["Control", "TouchButtonStyle", "1"],
    ["Control", "TouchButtonOpacity", "78"],
    ["Control", "TouchButtonHideSeconds", "0"],
    ["Control", "TouchGliding", "True"],
    ["TouchControls.Landscape", "ShowTouchCross", "True"],
    ["TouchControls.Landscape", "ShowTouchCircle", "True"],
    ["TouchControls.Landscape", "ShowTouchSquare", "True"],
    ["TouchControls.Landscape", "ShowTouchTriangle", "True"],
    ["TouchControls.Landscape", "ShowTouchDpad", "True"],
    ["TouchControls.Landscape", "ShowAnalogStick", "True"],
    ["TouchControls.Landscape", "ShowTouchStart", "True"],
    ["TouchControls.Landscape", "ShowTouchSelect", "True"],
    ["TouchControls.Landscape", "ShowTouchLTrigger", "True"],
    ["TouchControls.Landscape", "ShowTouchRTrigger", "True"],
    ["TouchControls.Landscape", "ShowTouchPause", "True"],
    ["TouchControls.Landscape", "ActionButtonScale", "1.58"],
    ["TouchControls.Landscape", "DPadScale", "1.58"],
    ["TouchControls.Landscape", "AnalogStickScale", "1.48"],
    ["TouchControls.Landscape", "StartKeyScale", "1.28"],
    ["TouchControls.Landscape", "SelectKeyScale", "1.28"],
    ["TouchControls.Landscape", "PauseKeyScale", "1.12"],
    ["TouchControls.Landscape", "ActionButtonSpacing2", "1.08"],
    ["TouchControls.Landscape", "DPadSpacing", "1.06"],
  ];
  const MOBILE_EMULATOR_ARGS = ["--dpi", "1", "--xres", "1280", "--yres", "720"];

  /* ── Preferences shim (storage may be blocked) ──────────────────── */

  const prefs = (() => {
    const fallback = new Map();
    return {
      get(k) { if (fallback.has(k)) return fallback.get(k); try { return localStorage.getItem(k); } catch (_) { return null; } },
      set(k, v) { fallback.set(k, String(v)); try { localStorage.setItem(k, String(v)); } catch (_) {} },
      del(k) { fallback.delete(k); try { localStorage.removeItem(k); } catch (_) {} },
    };
  })();

  /* ── Small helpers ──────────────────────────────────────────────── */

  const byId = (id) => document.getElementById(id);
  const on = (t, type, h, o) => (typeof t === "string" ? byId(t) : t)?.addEventListener(type, h, o);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtBytes = (n) => n < 1024 ? n + " B"
    : n < 1048576 ? (n / 1024).toFixed(1) + " KB"
    : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB"
    : (n / 1073741824).toFixed(2) + " GB";
  const isMobile = () => !!window.matchMedia?.("(pointer: coarse)")?.matches;

  /* ── Render resolution (from the core's SDL/SDLMain.cpp) ──────────
   * Without args the web SDL layer creates its canvas window at
   * 480x272 * 2 = 960x544 — the source of the blur on large displays.
   * "--xres <w>" / "--yres <h>" argv pairs set the real backing store,
   * and [Graphics] InternalResolution scales the PSP framebuffer so the
   * game renders near 1:1 with that canvas. */
  let RES_PLAN = { w: 960, h: 544, ir: 2, mobile: false };

  function computeRenderPlan() {
    if (isMobile()) {
      // touch devices: keep the upstream-fixed portrait-safe landscape size
      RES_PLAN = { w: 1280, h: 720, ir: 2, mobile: true };
      return RES_PLAN;
    }
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.5));
    let w = Math.round((window.innerWidth || 1280) * dpr);
    let h = Math.round((window.innerHeight || 720) * dpr);
    const f = Math.min(1, 2560 / w, 1440 / h); // ~3.7 mp composite budget
    w = Math.max(480, Math.round(w * f));
    h = Math.max(272, Math.round(h * f));
    const ir = Math.max(2, Math.min(5, Math.round(h / 272))); // psp fb = 272 lines
    RES_PLAN = { w, h, ir, mobile: false };
    return RES_PLAN;
  }

  function toast(msg, ms = 3200) {
    const el = byId("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), ms);
  }

  /* ── Log ring ───────────────────────────────────────────────────── */

  const logRing = [];
  function log(text, level = "") {
    const ts = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const raw = "[" + ts + "] " + text;
    const line = { raw, level: level || classifyLine(raw) };
    logRing.push(line);
    if (logRing.length > 500) logRing.shift();
    if (line.level === "err") console.warn(raw);
    else if (prefs.get("sg_debug") === "1") console.log(raw);
    bootConsoleLine(line);
    renderLogThrottled();
  }
  /* boot-screen console: mirrors the log ring until the splash is hidden */
  function bootConsoleLine(line) {
    const c = document.getElementById("bootConsole");
    if (!c || byId("boot").classList.contains("hide")) return;
    const d = document.createElement("div");
    d.className = "line l-" + line.level;
    d.textContent = line.raw;
    c.appendChild(d);
    while (c.childElementCount > 140) c.firstElementChild.remove();
    c.scrollTop = c.scrollHeight;
  }
  function classifyLine(t) {
    const s = t.toLowerCase();
    if (/error|abort|failed|fail|crash/.test(s)) return "err";
    if (/warn/.test(s)) return "warn";
    if (/\b(ok|ready|loaded|initialized|done|connected)\b/.test(s)) return "ok";
    return "";
  }
  let _logRaf = 0;
  function renderLogThrottled() {
    if (_logRaf) return;
    _logRaf = requestAnimationFrame(() => {
      _logRaf = 0;
      if (infoPanelTab === "log") renderLog();
    });
  }
  function renderLog() {
    const view = byId("logView");
    if (!view) return;
    const q = (byId("logFilter")?.value || "").toLowerCase();
    const rows = (q ? logRing.filter((l) => l.raw.toLowerCase().includes(q)) : logRing);
    view.innerHTML = rows.map((l) => {
      const m = l.raw.match(/^(\[\d{1,2}:\d{2}:\d{2}\]) (.*)$/s);
      return m
        ? `<div class="log-line l-${l.level}"><span class="l-ts">${esc(m[1])}</span> ${esc(m[2])}</div>`
        : `<div class="log-line">${esc(l.raw)}</div>`;
    }).join("\n");
    view.scrollTop = view.scrollHeight;
  }

  /* ── OPFS primitives ────────────────────────────────────────────── */

  let _opfsRoot = null;
  function hasOPFS() { return !!navigator.storage?.getDirectory; }
  async function opfsRoot() {
    if (_opfsRoot) return _opfsRoot;
    const base = await navigator.storage.getDirectory();
    _opfsRoot = await base.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
    return _opfsRoot;
  }
  async function opfsDir(parts, create, baseName = OPFS_PERSIST_DIR) {
    let dir = await opfsRoot();
    for (const p of [baseName, ...parts]) if (p) dir = await dir.getDirectoryHandle(p, { create: !!create });
    return dir;
  }
  async function opfsWrite(path, data, baseName) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    const dir = await opfsDir(parts, true, baseName);
    const writable = await dir.getFileHandle(name, { create: true }).then((h) => h.createWritable());
    try { await writable.write(data); await writable.close(); }
    catch (e) { try { await writable.abort(); } catch (_) {} throw e; }
  }
  async function opfsRead(path, baseName = OPFS_PERSIST_DIR) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    const dir = await opfsDir(parts, false, baseName);
    const file = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }
  async function opfsGetFile(path, baseName = OPFS_PERSIST_DIR) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    const dir = await opfsDir(parts, false, baseName);
    return (await dir.getFileHandle(name)).getFile();
  }
  async function opfsDelete(path, baseName = OPFS_PERSIST_DIR) {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop();
    const dir = await opfsDir(parts, false, baseName);
    await dir.removeEntry(name);
  }
  async function opfsWalk(baseName = OPFS_PERSIST_DIR, withData = false) {
    const entries = [];
    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        const rel = prefix ? prefix + "/" + name : name;
        if (handle.kind === "directory") await walk(handle, rel);
        else {
          const file = await handle.getFile();
          const entry = { path: baseName === OPFS_PERSIST_DIR ? "/" + rel : rel, name, size: file.size, file };
          if (withData) entry.data = new Uint8Array(await file.arrayBuffer());
          entries.push(entry);
        }
      }
    };
    try { await walk(await opfsDir([], false, baseName), ""); }
    catch (e) { /* first run: directory missing */ }
    return entries;
  }

  /* ── Game store (OPFS-backed library) ───────────────────────────── */

  const safeName = (n) => n.replace(/[^a-zA-Z0-9._-]/g, "_");
  const prettyName = (n) => n.replace(GAME_FILE_EXT_RE, "").replace(/[._-]+/g, " ").trim() || n;

  async function libraryList() {
    return (await opfsWalk(OPFS_GAMES_DIR, false)).sort((a, b) => a.path.localeCompare(b.path));
  }
  async function libraryPut(name, fileOrBytes) {
    return await opfsWrite(safeName(name), fileOrBytes, OPFS_GAMES_DIR);
  }
  async function libraryGet(name) { return await opfsGetFile(safeName(name), OPFS_GAMES_DIR); }
  async function libraryDelete(name) {
    await opfsDelete(safeName(name), OPFS_GAMES_DIR);
    for (const suffix of [".json", ".cover"]) {
      try { await opfsDelete(safeName(name) + suffix, OPFS_GAME_META_DIR); } catch (_) {}
    }
  }
  async function metaPut(name, doc) {
    await opfsWrite(safeName(name) + ".json", new TextEncoder().encode(JSON.stringify(doc)), OPFS_GAME_META_DIR);
  }
  async function metaGet(name) {
    try {
      return JSON.parse(new TextDecoder().decode(await opfsRead(safeName(name) + ".json", OPFS_GAME_META_DIR)));
    } catch (_) { return null; }
  }
  async function coverGet(name) {
    try { return await opfsRead(safeName(name) + ".cover", OPFS_GAME_META_DIR); } catch (_) { return null; }
  }
  async function coverPut(name, bytes) {
    await opfsWrite(safeName(name) + ".cover", bytes, OPFS_GAME_META_DIR);
  }

  /* ── Disk image readers: plain ISO + CSO, one abstraction ───────── */

  const csoHeaderCache = new WeakMap();

  async function inflateRaw(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function csoHeader(file) {
    if (csoHeaderCache.has(file)) return csoHeaderCache.get(file);
    const head = new Uint8Array(await file.slice(0, 24).arrayBuffer());
    if (head.length < 24 || head[0] !== 0x43 || head[1] !== 0x49 || head[2] !== 0x53 || head[3] !== 0x4f)
      return null; // not CISO
    const view = new DataView(head.buffer);
    const blockSize = view.getUint32(16, true);
    const indexShift = head[21];
    const totalBytes = Number(view.getBigUint64(8, true));
    const numFrames = Math.ceil(totalBytes / blockSize);
    const indexBytes = await file.slice(24, 24 + (numFrames + 1) * 4).arrayBuffer();
    const index = new Uint32Array(indexBytes);
    const meta = { blockSize, indexShift, totalBytes, numFrames, index };
    csoHeaderCache.set(file, meta);
    return meta;
  }

  async function csoReadRange(file, start, size) {
    const meta = await csoHeader(file);
    if (!meta) return null;
    if (start + size > meta.totalBytes) size = Math.max(0, meta.totalBytes - start);
    const first = Math.floor(start / meta.blockSize);
    const last = Math.floor((start + size - 1) / meta.blockSize);
    if (size <= 0 || last < first) return new Uint8Array(0);
    const parts = new Array(last - first + 1);
    for (let f = first; f <= last; f++) {
      const idxRaw = meta.index[f];
      const plain = (idxRaw & 0x80000000) !== 0;
      const off = (idxRaw & 0x7fffffff) << meta.indexShift;
      const offEnd = (meta.index[f + 1] & 0x7fffffff) << meta.indexShift;
      const bytes = new Uint8Array(await file.slice(off, offEnd).arrayBuffer());
      if (!plain) {
        // Frame may span past the slice; inflate the whole frame and use [skipFrom…]
        try { parts[f - first] = { data: await inflateRaw(bytes), full: true }; }
        catch (e) { throw new Error("CSO frame inflate failed @" + f); }
      } else {
        parts[f - first] = { data: bytes, full: false };
      }
    }
    const avail = parts.reduce((s, p) => s + p.data.byteLength, 0) - (start - first * meta.blockSize);
    const want = Math.min(size, Math.max(0, avail));
    const out = new Uint8Array(want);
    let o = 0;
    for (let i = 0; i < parts.length && o < want; i++) {
      const p = parts[i];
      const from = (i === 0) ? start - first * meta.blockSize : 0;
      if (from >= p.data.byteLength) continue;
      const take = Math.min(p.data.byteLength - from, want - o);
      out.set(p.data.subarray(from, from + take), o);
      o += take;
    }
    return out;
  }

  function makeReader(file) {
    if (/\.cso$/i.test(file.name || "")) {
      return {
        isCso: true,
        size: Infinity, // unknown until header read; readers don't rely on size
        read: async (off, len) => (await csoReadRange(file, off, len)),
      };
    }
    return {
      isCso: false,
      size: file.size,
      read: async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer()),
    };
  }

  /* ── ISO-9660 metadata extraction (title + cover) ───────────────── */

  function readIsoDirRec(view, offset) {
    const len = view.getUint8(offset);
    if (!len) return null;
    return {
      len,
      extent: view.getUint32(offset + 2, true),
      size: view.getUint32(offset + 10, true),
      flags: view.getUint8(offset + 25),
      name: nameOf(view, offset),
    };
    function nameOf(v, o) {
      const n = v.getUint8(o + 32);
      let s = "";
      for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(o + 33 + i));
      return s.replace(/;1$/i, "");
    }
  }

  async function isoFindEntry(reader, wantedPath) {
    const pvdStart = 16 * 2048;
    const pvd = await reader.read(pvdStart, 2048);
    if (!pvd || pvd.length < 2048) return null;
    const v1 = new DataView(pvd.buffer, pvd.byteOffset, pvd.byteLength);
    if (v1.getUint8(0) !== 1 || String.fromCharCode(v1.getUint8(1), v1.getUint8(2), v1.getUint8(3), v1.getUint8(4), v1.getUint8(5)) !== "CD001") return null;
    const root = readIsoDirRec(v1, 156);
    if (!root) return null;

    const parts = wantedPath.toUpperCase().split("/").filter(Boolean);
    let dir = root;
    for (const target of parts) {
      const dirBytes = await reader.read(dir.extent * 2048, Math.min(dir.size, 6 * 1048576));
      const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
      let found = null;
      let off = 0;
      while (off < dirBytes.byteLength) {
        const len = dv.getUint8(off);
        if (!len) { off = (Math.floor(off / 2048) + 1) * 2048; continue; }
        const rec = readIsoDirRec(dv, off);
        off += rec.len;
        if (!rec.name || rec.name === "\u0000" || rec.name === "\u0001") continue;
        if (rec.name.toUpperCase() === target) { found = rec; break; }
      }
      if (!found) return null;
      dir = found;
    }
    return { extent: dir.extent * 2048, size: dir.size };
  }

  async function parseSfoTitle(data) {
    if (!data || data.byteLength < 20) return "";
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(0, true) !== 0x46535000) return "";
    const keyTable = view.getUint32(8, true);
    const dataTable = view.getUint32(12, true);
    const count = view.getUint32(16, true);
    for (let i = 0; i < count; i++) {
      const recOff = 20 + i * 16;
      const keyOff = view.getUint16(recOff, true);
      const dataLen = view.getUint32(recOff + 4, true);
      const dataOff = view.getUint32(recOff + 12, true);
      let end = keyTable + keyOff;
      while (end < data.byteLength && data[end] !== 0) end++;
      const key = new TextDecoder().decode(data.subarray(keyTable + keyOff, end));
      if (key !== "TITLE") continue;
      return new TextDecoder().decode(data.subarray(dataTable + dataOff, dataTable + dataOff + dataLen)).replace(/\0+$/g, "").trim();
    }
    return "";
  }

  async function extractGameMeta(name, file) {
    const doc = { fileName: safeName(name), title: prettyName(name), format: (name.split(".").pop() || "").toUpperCase() };
    try {
      const reader = makeReader(file);
      const sfo = await isoFindEntry(reader, "PSP_GAME/PARAM.SFO");
      if (sfo) {
        const bytes = await reader.read(sfo.extent, Math.min(sfo.size, 1 << 20));
        const title = await parseSfoTitle(bytes);
        if (title) doc.title = title;
      }
      const icon = await isoFindEntry(reader, "PSP_GAME/ICON0.PNG");
      if (icon) {
        const bytes = await reader.read(icon.extent, Math.min(icon.size, 1 << 19));
        await coverPut(safeName(name), bytes);
      }
    } catch (e) {
      log("Library metadata parse failed for " + safeName(name) + ": " + e.message, "warn");
    }
    await metaPut(safeName(name), doc);
    return doc;
  }

  /* ── Boot page / progress UX ────────────────────────────────────── */

  function splashProgress(frac, status) {
    if (frac != null) byId("bootbar-fill").style.width = Math.max(2, Math.min(100, frac * 100)) + "%";
    if (status != null) byId("bootstatus").textContent = status;
  }
  function splashError(message) {
    const el = byId("booterror");
    el.hidden = false;
    el.textContent = message;
  }
  function hideBoot() {
    const b = byId("boot");
    b.classList.add("hide");
    setTimeout(() => b.classList.add("gone"), 650);
  }

  /* ── Status badge on stage ──────────────────────────────────────── */

  function stageBadge(text, tone) {
    const el = byId("stagebadge");
    if (!el) return;
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
    el.dataset.tone = tone || "";
  }

  /* ── PSF / config ini patcher ───────────────────────────────────── */

  function patchIniValue(text, section, key, value, overwrite = true) {
    const lines = text ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : [];
    const header = "[" + section + "]";
    const sectionRe = /^\s*\[([^\]]+)\]\s*$/;
    const keyRe = new RegExp("^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=");
    let start = -1, end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(sectionRe);
      if (!m) continue;
      if (m[1] === section) {
        start = i;
        for (let j = i + 1; j < lines.length; j++) if (sectionRe.test(lines[j])) { end = j; break; }
        break;
      }
    }
    if (start === -1) {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(header, key + " = " + value);
    } else {
      for (let i = start + 1; i < end; i++) {
        if (keyRe.test(lines[i])) {
          if (!overwrite) return text;
          lines[i] = key + " = " + value;
          return lines.join("\n").replace(/\n*$/, "\n");
        }
      }
      lines.splice(end, 0, key + " = " + value);
    }
    return lines.join("\n").replace(/\n*$/, "\n");
  }

  async function forceGamesDirectoryConfig(FS) {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    for (const root of PERSIST_ROOTS) {
      const iniPath = root + "/PSP/SYSTEM/ppsspp.ini";
      try {
        fsMkdirP(FS, root + "/PSP/SYSTEM");
        let text = "";
        try { text = dec.decode(FS.readFile(iniPath)); } catch (e) {}
        let patched = patchIniValue(text, "General", "CurrentDirectory", VIRTUAL_GAME_DIR);
        for (const [s, k, v] of WEB_NATIVE_TIMING_CONFIG) patched = patchIniValue(patched, s, k, v, false);
        for (const [s, k, v] of WEB_STABILITY_CONFIG) patched = patchIniValue(patched, s, k, v, false);
        patched = patchIniValue(patched, "Graphics", "InternalResolution", String(RES_PLAN.ir), false);
        if (isMobile()) for (const [s, k, v] of MOBILE_TOUCH_CONFIG) patched = patchIniValue(patched, s, k, v, false);
        const bytes = enc.encode(patched);
        FS.writeFile(iniPath, bytes);
        await opfsWrite(iniPath.slice(1), bytes);
      } catch (e) {
        log("Config defaults failed at " + iniPath + ": " + e.message, "warn");
      }
    }
  }

  /* ── Persistence mirror (Emscripten FS ⇄ OPFS) ──────────────────── */

  let memstickRoot = PERSIST_ROOTS[0];
  let _lastPersist = 0;
  const _persistedFingerprint = new Map();
  let _persistQueue = Promise.resolve();

  function fsMkdirP(FS, full) {
    let cur = "";
    for (const p of full.split("/").filter(Boolean)) { cur += "/" + p; try { FS.mkdir(cur); } catch (_) {} }
  }
  function fsStatWalk(FS, root) {
    const out = new Map();
    const walk = (dir) => {
      let entries; try { entries = FS.readdir(dir); } catch (_) { return; }
      for (const n of entries) {
        if (n === "." || n === "..") continue;
        const full = dir + "/" + n;
        let st; try { st = FS.stat(full); } catch (_) { continue; }
        if (FS.isDir(st.mode)) walk(full);
        else out.set(full, { size: st.size, mtime: st.mtime });
      }
    };
    walk(root);
    return out;
  }
  function fsDataWalk(FS, root) {
    const out = [];
    const walk = (dir) => {
      let entries; try { entries = FS.readdir(dir); } catch (_) { return; }
      for (const n of entries) {
        if (n === "." || n === "..") continue;
        const full = dir + "/" + n;
        let st; try { st = FS.stat(full); } catch (_) { continue; }
        if (FS.isDir(st.mode)) walk(full);
        else { try { out.push({ path: full, data: FS.readFile(full) }); } catch (_) {} }
      }
    };
    walk(root);
    return out;
  }

  function persistFiles(FS, label) {
    const task = _persistQueue.then(() => persistNow(FS, label));
    _persistQueue = task.catch((e) => log("Persistence failed: " + e.message, "warn"));
    return task;
  }
  async function persistNow(FS, label) {
    if (!FS || !hasOPFS()) return;
    memstickRoot = PERSIST_ROOTS.find((r) => { try { return FS.analyzePath(r).exists; } catch (_) { return false; } }) || PERSIST_ROOTS[0];
    const stats = fsStatWalk(FS, memstickRoot);
    const dirty = [];
    for (const [path, fp] of stats) {
      const fingerprint = fp.size + ":" + fp.mtime;
      if (_persistedFingerprint.get(path) !== fingerprint) dirty.push({ path, fingerprint, data: null });
    }
    const deleted = [..._persistedFingerprint.keys()].filter((p) => !stats.has(p));
    if (!dirty.length && !deleted.length) return;
    let written = 0, removed = 0;
    for (const d of dirty) {
      try {
        const data = FS.readFile(d.path);
        // Path in OPFS excludes the leading "/".
        await opfsWrite(d.path.slice(1), data);
        _persistedFingerprint.set(d.path, d.fingerprint);
        written++;
      } catch (e) { log("Persist write failed " + d.path + ": " + e.message, "warn"); }
    }
    for (const path of deleted) {
      try { await opfsDelete(path.slice(1)); }
      catch (e) { if (e && e.name !== "NotFoundError") continue; }
      _persistedFingerprint.delete(path);
      removed++;
    }
    _lastPersist = Date.now();
    const parts = [];
    if (written) parts.push(written + " written");
    if (removed) parts.push(removed + " removed");
    log("Persistence [" + (label || "auto") + "]: " + (parts.join(", ") || "no changes") + " · " + stats.size + " files tracked.", "ok");
    updateStorageLine();
  }

  async function restorePersistedFiles(FS) {
    if (!hasOPFS()) return;
    try {
      const entries = await opfsWalk(OPFS_PERSIST_DIR, false);
      if (!entries.length) { log("Persistence: nothing stored yet.", ""); return; }
      let ok = 0;
      for (const entry of entries) {
        try {
          const data = new Uint8Array(await entry.file.arrayBuffer());
          fsMkdirP(FS, entry.path.substring(0, entry.path.lastIndexOf("/")) || "/");
          FS.writeFile(entry.path, data);
          ok++;
        } catch (e) { log("Restore failed " + entry.path + ": " + e.message, "warn"); }
      }
      log("Persistence: restored " + ok + "/" + entries.length + " files.", "ok");
      // Seed fingerprints so the first sync is incremental too.
      memstickRoot = PERSIST_ROOTS.find((r) => { try { return FS.analyzePath(r).exists; } catch (_) { return false; } }) || PERSIST_ROOTS[0];
      for (const [path, fp] of fsStatWalk(FS, memstickRoot)) _persistedFingerprint.set(path, fp.size + ":" + fp.mtime);
    } catch (e) {
      log("Persistence restore error: " + e.message, "warn");
    }
  }

  function startAutoPersist() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && runtimeReady && window.FS) void persistFiles(window.FS, "background");
    });
    window.addEventListener("beforeunload", () => { if (runtimeReady && window.FS) void persistFiles(window.FS, "unload"); });
    setInterval(() => {
      const FS = window.FS;
      if (!runtimeReady || !FS) return;
      persistFiles(FS, "auto");
    }, PERSIST_SYNC_MS);
  }

  function updateStorageLine() {
    const el = byId("storageLine");
    if (!el) return;
    void updateStorageLineAsync(el);
  }
  let _storageLineBusy = false;
  async function updateStorageLineAsync(el) {
    if (_storageLineBusy) return;
    _storageLineBusy = true;
    try {
      let bytes = 0;
      for (const g of await libraryList()) bytes += g.size;
      for (const p of await opfsWalk(OPFS_PERSIST_DIR, false)) bytes += p.size;
      let quota = 0, usage = 0;
      try {
        const est = await navigator.storage?.estimate?.();
        quota = est?.quota || 0;
        usage = est?.usage || 0;
      } catch (_) {}
      el.textContent = "Game media " + fmtBytes(bytes) +
        " · site storage " + fmtBytes(usage) + (quota ? " / " + fmtBytes(quota) : "");
    } catch (_) {
      el.textContent = "";
    }
    _storageLineBusy = false;
  }

  /* ── Audio: ScriptProcessor → AudioWorklet shim (upstream design) ─ */

  const SP_SHIM_WORKLET = `
class PPSSPPSpShim extends AudioWorkletProcessor {
  constructor(opts) {
    super(opts);
    const p = opts.processorOptions || {};
    this._nCh = p.channels || 2;
    this._cap = p.cap || 65536;
    this._ctrl = new Int32Array(p.sab, 0, 8);
    this._data = new Float32Array(p.sab, 32, this._cap * this._nCh);
    this._last = new Float32Array(this._nCh);
    this._ramp = 0;
    this._rampFrames = 128;
  }
  process(inputs, outputs) {
    const ch = outputs[0];
    if (!ch || !ch[0]) return true;
    const n = ch[0].length;
    let r = Atomics.load(this._ctrl, 1);
    const w = Atomics.load(this._ctrl, 0);
    const cap = this._cap;
    const avail = (w - r + cap) % cap;
    const read = Math.min(n, avail);
    let ramp = this._ramp;
    for (let i = 0; i < read; i++) {
      const blend = ramp > 0 ? 1.0 - ramp / this._rampFrames : 1.0;
      for (let c = 0; c < ch.length; c++) {
        const src = this._data[r * this._nCh + Math.min(c, this._nCh - 1)];
        const out = ramp > 0 ? this._last[c] * (1.0 - blend) + src * blend : src;
        ch[c][i] = out;
        this._last[c] = out;
      }
      if (ramp > 0) ramp--;
      r = (r + 1) % cap;
    }
    this._ramp = ramp;
    if (read < n) {
      Atomics.add(this._ctrl, 4, 1);
      this._ramp = this._rampFrames;
      for (let i = read; i < n; i++) {
        for (let c = 0; c < ch.length; c++) {
          this._last[c] *= 0.985;
          ch[c][i] = Math.abs(this._last[c]) < 0.00001 ? 0 : this._last[c];
        }
      }
    }
    Atomics.store(this._ctrl, 1, r);
    Atomics.add(this._ctrl, 2, read);
    return true;
  }
}
registerProcessor('ppsspp-sp-shim', PPSSPPSpShim);
`;

  const _spCtxSet = new WeakSet();
  const _spPending = new WeakMap();

  async function ensureSpShimModule(ctx) {
    if (_spCtxSet.has(ctx)) return true;
    if (_spPending.has(ctx)) return _spPending.get(ctx);
    const p = (async () => {
      try {
        const url = URL.createObjectURL(new Blob([SP_SHIM_WORKLET], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        _spCtxSet.add(ctx);
        log("AUDIO: SP→Worklet shim module ready.", "ok");
        return true;
      } catch (e) {
        log("AUDIO: SP shim module failed: " + (e?.message || e), "warn");
        return false;
      }
    })();
    _spPending.set(ctx, p);
    return p;
  }

  function makeScriptProcessorShim(ctx, bufferSize, nIn, nOut) {
    const nCh = Math.max(1, nOut || 2);
    const bufsz = bufferSize || 2048;
    const SR = ctx.sampleRate || 44100;
    const RING_CAP = 32768;
    const LOOKAHEAD = Math.max(SR * 0.070, bufsz * 2);
    const MAX_FILL = Math.max(SR * 0.180, bufsz * 5);
    const MAX_BURST = 16;

    let _handler = null, _wn = null, _gain = null, _dest = null, _timerId = null;
    let _fakeBuf = null, _fakeCh = [];
    let _ctrl = null, _data = null;

    let _playheadStart = 0, _produced = 0, _lastUnderruns = 0, _lastUnderrunAt = 0, _adaptive = 0;

    try {
      _fakeBuf = ctx.createBuffer(nCh, bufsz, SR);
      _fakeCh = Array.from({ length: nCh }, (_, c) => _fakeBuf.getChannelData(c));
    } catch (_) {}

    function pushOne() {
      if (!_handler || !_fakeBuf || !_wn || !_ctrl || !_data) return false;
      let w = Atomics.load(_ctrl, 0);
      const used = (w - Atomics.load(_ctrl, 1) + RING_CAP) % RING_CAP;
      if (bufsz > RING_CAP - 1 - used) return false;
      try { _handler({ outputBuffer: _fakeBuf }); } catch (_) { return false; }
      for (let i = 0; i < bufsz; i++) {
        for (let c = 0; c < nCh; c++) _data[w * nCh + c] = _fakeCh[c][i];
        w = (w + 1) % RING_CAP;
      }
      Atomics.store(_ctrl, 0, w);
      _produced += bufsz;
      return true;
    }

    function pump() {
      if (ctx.state !== "running" || !_handler || !_wn) return;
      if (!_playheadStart) _playheadStart = ctx.currentTime || 0;
      const underruns = Atomics.load(_ctrl, 4);
      if (underruns !== _lastUnderruns) {
        _lastUnderruns = underruns;
        _lastUnderrunAt = ctx.currentTime;
        _adaptive = Math.min(SR * 0.120, _adaptive + bufsz);
      } else if (_adaptive > 0 && ctx.currentTime - _lastUnderrunAt > 3) {
        _adaptive = Math.max(0, _adaptive - bufsz * 0.25);
      }
      const fill = (Atomics.load(_ctrl, 0) - Atomics.load(_ctrl, 1) + RING_CAP) % RING_CAP;
      if (fill > MAX_FILL + _adaptive) return;
      const elapsed = Math.max(0, Math.floor((ctx.currentTime - _playheadStart) * SR));
      if (_produced < elapsed - MAX_FILL) { _playheadStart = ctx.currentTime; _produced = 0; }
      let n = 0;
      while (_produced + bufsz <= elapsed + LOOKAHEAD + _adaptive && _produced + bufsz <= elapsed + MAX_FILL + _adaptive && n < MAX_BURST) {
        if (!pushOne()) break;
        n++;
      }
    }

    (async () => {
      if (!(await ensureSpShimModule(ctx))) return;
      try {
        if (typeof SharedArrayBuffer === "undefined") { log("AUDIO: no SAB; shim disabled.", "err"); return; }
        const sab = new SharedArrayBuffer(32 + RING_CAP * nCh * 4);
        _ctrl = new Int32Array(sab, 0, 8);
        _data = new Float32Array(sab, 32, RING_CAP * nCh);
        _wn = new AudioWorkletNode(ctx, "ppsspp-sp-shim", {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [nCh],
          processorOptions: { channels: nCh, cap: RING_CAP, sab },
        });
        _wn.onprocessorerror = (e) => log("AUDIO: SP shim processor error: " + (e?.message || e), "warn");
        _gain = ctx.createGain();
        _gain.gain.value = 1.0;
        _wn.connect(_gain);
        _gain.connect(_dest = ctx.destination);
        if (_handler) {
          _timerId = setInterval(pump, 2);
          log("AUDIO: SP shim pump started (bufsz=" + bufsz + " SR=" + SR + ").", "ok");
        }
      } catch (e) {
        log("AUDIO: SP shim node failed: " + (e?.message || e), "warn");
      }
    })();

    return {
      get onaudioprocess() { return _handler; },
      set onaudioprocess(fn) {
        _handler = fn;
        if (_wn && _dest && !_timerId) { _timerId = setInterval(pump, 2); log("AUDIO: SP shim pump started.", "ok"); }
      },
      connect(dest) { _dest = dest; },
      disconnect() { if (_timerId) { clearInterval(_timerId); _timerId = null; } },
      addEventListener() {}, removeEventListener() {},
    };
  }

  async function installAudioPipeline() {
    if (audioContext) return audioContext; // one shared AudioContext for the shell + SDL2
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { log("AUDIO: WebAudio unavailable.", "warn"); return null; }
      const ctx = new AudioContext({ latencyHint: "interactive" });
      if (ctx.audioWorklet) await ensureSpShimModule(ctx);
      const proto = AudioContext.prototype;
      if (!proto._sgSpPatched) {
        proto._sgSpPatched = true;
        const orig = proto.createScriptProcessor;
        proto.createScriptProcessor = function (bufSize, nIn, nOut) {
          log("AUDIO: createScriptProcessor → WorkletShim (bufSz=" + bufSize + ").", "info");
          return makeScriptProcessorShim(this, bufSize, nIn, nOut);
        };
        log("AUDIO: ScriptProcessor→AudioWorklet polyfill installed.", "ok");
      }
      return ctx;
    } catch (e) {
      log("AUDIO: pre-init failed: " + (e?.message || e), "warn");
      return null;
    }
  }

  async function unlockAudio() {
    const ctx = window.Module?.SDL2?.audioContext;
    if (ctx && (ctx.state === "suspended" || ctx.state === "interrupted")) {
      try { await ctx.resume(); log("AUDIO: AudioContext resumed: " + ctx.state, "ok"); } catch (_) {}
    }
  }
  on(window, "pointerdown", () => void unlockAudio(), { passive: true });
  on(window, "keydown", () => void unlockAudio(), { passive: true });
  on(document, "visibilitychange", () => { if (!document.hidden && started) void unlockAudio(); });
  on(window, "focus", () => { if (started) void unlockAudio(); });

  /* ── GPU probe ──────────────────────────────────────────────────── */

  const gpuInfo = { renderer: "", vendor: "", webgl2: false, simd: false, maxTex: 0, hasStencil: false };
  function probeGPU() {
    try {
      const pc = document.createElement("canvas");
      const gl = pc.getContext("webgl2", { powerPreference: "high-performance", alpha: false, antialias: false, depth: true, stencil: true });
      gpuInfo.webgl2 = !!gl;
      if (!gl) { log("GPU: WebGL2 unavailable — GLES3 rendering cannot start.", "err"); return; }
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      gpuInfo.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      gpuInfo.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      gpuInfo.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      gpuInfo.hasStencil = !!gl.getExtension("WEBGL_stencil_texturing");
      try { gpuInfo.simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (_) {}
      log("GPU: " + gpuInfo.renderer, "ok");
      if (!gpuInfo.hasStencil) log("Without WEBGL_stencil_texturing some games may show black scenes.", "warn");
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch (e) {
      log("GPU probe failed: " + e.message, "warn");
    }
  }

  /* ── FPS tick ───────────────────────────────────────────────────── */

  let fpsFrames = 0, fpsLast = performance.now(), fpsValue = 0;
  (function tickFps() {
    fpsFrames++;
    const now = performance.now();
    if (now - fpsLast >= 1000) {
      fpsValue = Math.round((fpsFrames * 1000) / (now - fpsLast));
      fpsFrames = 0; fpsLast = now;
      const el = document.getElementById("fpsline");
      if (el && runtimeReady) el.innerHTML = "fps <b>" + fpsValue + "</b>";
    }
    requestAnimationFrame(tickFps);
  })();

  /* ── Footer overlay ─────────────────────────────────────────────── */
  // Reveal only when the pointer sits in the bottom 3% (CSS handles
  // #footzone:hover; this tracks big smooth mouse moves too).
  on(window, "mousemove", (e) => {
    const y = e.clientY, h = window.innerHeight || screen.height;
    if (y > h * 0.97) document.body.classList.add("foot-reveal");
    else if (y < h * 0.90) document.body.classList.remove("foot-reveal");
  }, { passive: true });

  /* ── Emscripten boot ────────────────────────────────────────────── */

  let started = false;
  let runtimeReady = false;
  let runtimeFailed = false;
  let buildRevision = "";
  let audioContext = null;
  let currentGameStem = ""; // stem of the booted game file (library highlight)

  async function loadBuildInfo() {
    try {
      const info = await (await fetch("build-info.json", { cache: "no-store" })).json();
      buildRevision = String(info.revision_sha256 || "").slice(0, 12);
      if (info.source) log("Vendored core: " + info.source, "");
      log("Core revision: " + buildRevision, "ok");
    } catch (_) {
      log("build-info.json not present", "warn");
    }
  }

  function confirmDialog(text) {
    return new Promise((resolve) => {
      const modal = byId("confirmmodal");
      byId("confirmText").textContent = text;
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
      const yes = byId("confirmYes"), no = byId("confirmNo");
      const close = (result) => {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
        yes.onclick = no.onclick = null;
        resolve(result);
      };
      yes.onclick = () => close(true);
      no.onclick = () => close(false);
    });
  }

  function failRuntime(message) {
    runtimeFailed = true;
    runtimeReady = false;
    clearTimeout(window._sgWatchdog);
    log(message, "err");
    splashProgress(null, "");
    splashError(message);
    stageBadge("Failed — " + message, "err");
  }

  function makeWorkerFsGameFile(file, safe) {
    if (!file || file.name === safe || typeof File !== "function") return file;
    return new File([file], safe, { type: file.type || "application/octet-stream", lastModified: file.lastModified || 0 });
  }

  function mountGameFileFast(FS, file, safe) {
    const workerFS = globalThis.WORKERFS || window.WORKERFS;
    if (!workerFS || !FS?.mount || typeof FileReaderSync === "undefined") return null;
    const mountFile = makeWorkerFsGameFile(file, safe);
    const mountDir = VIRTUAL_GAME_DIR + "/.m-" + Date.now().toString(36);
    try {
      FS.mkdirTree(VIRTUAL_GAME_DIR);
      FS.mkdirTree(mountDir);
      FS.mount(workerFS, { files: [mountFile] }, mountDir);
      const path = mountDir + "/" + mountFile.name;
      log("Fast-mounted via WORKERFS mount: " + path, "ok");
      return path;
    } catch (e) {
      log("WORKERFS mount failed, MEMFS fallback: " + e.message, "warn");
      try { if (FS.analyzePath?.(mountDir)?.exists) FS.rmdir(mountDir); } catch (_) {}
      return null;
    }
  }

  async function resolveBootGame() {
    // ?menu=1       → force the ppsspp home menu.
    // ?rom=<url>    → fetch any hosted game file (one-time), cache in OPFS, boot.
    // ?play=<id>    → boot something already imported/stored in this browser.
    // default       → ppsspp home menu.
    const params = new URLSearchParams(location.search);
    const romParam = params.get("rom");
    const playParam = params.get("play");
    const wantMenu = params.get("menu") === "1";
    let entry = null;
    if (romParam && !wantMenu) {
      entry = entryFromUrl(romParam);
    } else if (playParam && !wantMenu) {
      entry = { id: safeName(playParam), url: null };
    }
    return { wantMenu: wantMenu || !entry, entry, romParam, playParam };
  }

  function entryFromUrl(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl, location.href);
    } catch (_) {
      log("ignoring ?rom — not a valid url: " + rawUrl, "warn");
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      log("ignoring ?rom — only http(s) urls are supported.", "warn");
      return null;
    }
    let file;
    try { file = decodeURIComponent(u.pathname.split("/").pop() || "game"); }
    catch (_) { file = u.pathname.split("/").pop() || "game"; }
    const id = safeName(file);
    if (!id) { log("ignoring ?rom — cannot derive a filename from that url.", "warn"); return null; }
    return { id, url: u.href, title: prettyName(id) };
  }

  async function startSession(boot) {    if (started) return;
    const canvas = byId("canvas");
    started = true;
    log("Boot sequence starting.", "info");

    const { entry } = boot || {};

    const watchdog = setTimeout(() => {
      if (!runtimeReady) failRuntime("Startup timed out (120 s). Try reloading; your saves are safe.");
    }, 120000);
    window._sgWatchdog = watchdog;

    canvas?.focus();

    // Audio pipeline must exist before the SDL glue creates its device.
    audioContext = await installAudioPipeline();

    // ── Game media ──────────────────────────────────────────────────
    let mediaFile = null;  // browser File (OPFS-backed)
    let storedName = null; // library file name (safe)
    let gameArg = null;    // path inside the emscripten FS
    let downloaded = false;

    if (entry) {
      try {
        const stored = await findStoredEntry(entry.id);
        if (stored) {
          storedName = stored.name;
          mediaFile = stored.file;
          splashProgress(0.16, "loading " + (stored.title || prettyName(stored.name)) + " from browser storage…");
        } else if (entry.url) {
          log("fetching " + entry.id + " — one-time, cached offline after.", "info");
          await ensureOPFSOrWarn();
          const got = await downloadRomToOPFS(entry.url, (frac, status) => splashProgress(frac, status));
          mediaFile = got.file;
          storedName = got.name;
          downloaded = true;
          log("Game cached (" + fmtBytes(mediaFile.size) + ") — runs offline from the library now.", "ok");
        } else {
          log("Library game not found in OPFS: " + entry.id, "err");
          splashProgress(null, "");
          splashError("Not found in the browser library: " + entry.id + " — add the file first (load button).");
          return;
        }
      } catch (e) {
        failRuntime("Could not fetch game: " + (e?.message || e));
        return;
      }
    }

    splashProgress(0.20, "starting " + (entry ? (prettyName(storedName || entry.id)) + "…" : "ppsspp home menu…"));
    log(entry
      ? "Booting " + prettyName(storedName || entry.id) + " (" + fmtBytes(mediaFile?.size || 0) + " cached)"
      : "No game requested — PPSSPP home menu.", "info");
    currentGameStem = (storedName || entry?.id || "").toLowerCase().replace(/\.[^.]+$/, "");

    const plan = computeRenderPlan();
    const chosenArgs = plan.mobile
      ? MOBILE_EMULATOR_ARGS.slice()
      : ["--xres", String(plan.w), "--yres", String(plan.h)];
    log("render plan: " + plan.w + "x" + plan.h + " canvas · internal x" + plan.ir, "info");
    await ensureWorkerCompat();

    window.Module = {
      canvas,
      webglContextAttributes: {
        powerPreference: "high-performance",
        alpha: false, antialias: false, depth: true, stencil: true,
        preserveDrawingBuffer: false, desynchronized: true,
        failIfMajorPerformanceCaveat: false,
      },
      SDL2: audioContext ? { audioContext } : {},
      // Args are pushed in preRun; do not pre-set (the glue reads this after dependencies finish).
      arguments: [],
      locateFile(path) {
        let url = BUILD_DIR + path;
        if (/\.wasm$|\.worker\.js$|\.data$/.test(path)) url += "?v=" + (buildRevision || "1");
        return url;
      },
      print(text) { log("stdout: " + text); },
      printErr(text) { log("stderr: " + text); },
      setStatus(text) { if (text) { log(text, ""); stageBadge(text); } },
      monitorRunDependencies(left) {
        if (left > 0) { stageBadge("Runtime init · " + left + " dependencies", "run"); log("Run dependencies remaining: " + left, ""); }
      },
      preRun: [function () {
        try { ENV.SDL_EMSCRIPTEN_KEYBOARD_ELEMENT = "#canvas"; } catch (e) { log("ENV bridge failed: " + e, "warn"); }
        log("preRun: started.", "");
        addRunDependency("sg-boot");
        (async () => {
          try {
            const FS = window.FS || window.Module?.FS;
            FS.mkdirTree(VIRTUAL_GAME_DIR);
            await restorePersistedFiles(FS);
            await forceGamesDirectoryConfig(FS);
            if (mediaFile) {
              const safe = safeName(storedName || entry.id);
              if (downloaded) {
                try {
                  const doc = await extractGameMeta(storedName, mediaFile);
                  if (doc?.title) log("Metadata: " + doc.title, "ok");
                } catch (_) {}
              }
              const fast = mountGameFileFast(FS, mediaFile, safe);
              if (fast) gameArg = fast;
              else {
                const bytes = new Uint8Array(await mediaFile.arrayBuffer());
                const path = VIRTUAL_GAME_DIR + "/" + safe;
                FS.writeFile(path, bytes, { canOwn: true });
                gameArg = path;
                log("Game mounted into MEMFS heap (" + fmtBytes(bytes.byteLength) + ", canOwn): " + path, "ok");
              }
            }
            const args = chosenArgs.slice();
            if (gameArg) args.push(gameArg);
            Module.arguments.push(...args);
            log("PPSSPP argv: " + JSON.stringify(Module.arguments), "info");
          } catch (err) {
            log("preRun failed: " + (err?.stack || err), "err");
            failRuntime("Boot failed: " + (err?.message || String(err)));
            try { window.Module?.abort?.(String(err)); } catch (_) {}
            return;
          } finally {
            removeRunDependency("sg-boot");
          }
        })();
      }],
      onRuntimeInitialized() {
        clearTimeout(window._sgWatchdog);
        runtimeReady = true;
        document.body.classList.add("running");
        log("Runtime initialized." + (gameArg ? " Game booting." : " Home menu."), "ok");
        stageBadge(gameArg ? "" : "home menu");
        hideBoot();
        if (window.Module?._PPSSPP_RefreshGameBrowser) setTimeout(() => window.Module._PPSSPP_RefreshGameBrowser(), 400);
        startAutoPersist();
        setTimeout(() => { if (runtimeReady) void persistFiles(window.FS, "init"); }, 8000);
        updateInfo();
        renderLibrary();
      },
      onAbort(reason) { failRuntime("Runtime aborted: " + reason); },
    };

    const script = document.createElement("script");
    script.src = BUILD_DIR + "PPSSPPSDL.js?v=" + (buildRevision || "1");
    script.onload = () => log("PPSSPPSDL.js loaded.", "ok");
    script.onerror = () => failRuntime("Failed to load PPSSPPSDL.js — is /emulator/ present? Hard-reload to retry.");
    document.body.appendChild(script);
  }

  async function hasStoredGame(id) {
    try { await opfsGetFile(safeName(id), OPFS_GAMES_DIR); return true; }
    catch (_) { return false; }
  }

  // Resolve an id/title → the actual stored library file (name or stem match).
  async function findStoredEntry(id) {
    const wanted = safeName(id).toLowerCase();
    const stemOf = (s) => s.replace(/\.[^.]+$/, "");
    const games = await libraryList();
    let hit = games.find((g) => g.path.toLowerCase() === wanted) || null;
    if (!hit)
      hit = games.find((g) => stemOf(g.path.toLowerCase()) === stemOf(wanted)) || null;
    if (!hit) return null;
    const meta = await metaGet(hit.path);
    return { name: hit.path, file: hit.file, size: hit.size, title: meta?.title || null };
  }

  let _opfsWarned = false;
  async function ensureOPFSOrWarn() {
    if (hasOPFS()) return true;
    if (_opfsWarned) return false;
    _opfsWarned = true;
    splashError("Private storage (OPFS) is unavailable. The game can still run this session, but saves will not persist. Open with normal site permissions.");
    return false;
  }

  async function downloadRomToOPFS(url, onProgress) {
    let resp;
    try {
      resp = await fetch(url, { mode: "cors" });
    } catch (e) {
      throw new Error(
        'The host refused the fetch (CORS). The site serving "' + url + '" must allow cross-origin GET requests ' +
        "(Access-Control-Allow-Origin).");
    }
    if (!resp.ok || !resp.body) throw new Error("HTTP " + resp.status + " fetching " + url);
    const name = safeName(decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "game"));
    const total = Number(resp.headers.get("content-length") || 0);
    const root = await opfsRoot();
    const dir = await root.getDirectoryHandle(OPFS_GAMES_DIR, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    try {
      // Stream in chunks: never hold the whole game image in JS memory.
      const reader = resp.body.getReader();
      let received = 0;
      let lastUi = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        received += value.byteLength;
        const now = performance.now();
        if (onProgress && now - lastUi > 120) {
          lastUi = now;
          const frac = total ? received / total : null;
          onProgress(frac, "Fetching game… " + fmtBytes(received) + (total ? " / " + fmtBytes(total) : ""));
        }
      }
      await writable.close();
    } catch (e) {
      try { await writable.abort(); } catch (_) {}
      try { await dir.removeEntry(name); } catch (_) {}
      throw e;
    }
    const file = await (await dir.getFileHandle(name)).getFile();
    if (total && file.size !== total)
      log("Fetch size mismatch: got " + fmtBytes(file.size) + ", expected " + fmtBytes(total) + " — continuing.", "warn");
    log("Library: cached " + name + " (" + fmtBytes(file.size) + ").", "ok");
    return { file, name };
  }

  /* ── Cross-origin isolation handshake (static hosts) ────────────── */

  const COI_RELOAD_KEY = "sg-coi-reloads";
  // Returns true when the page has SharedArrayBuffer+wasm threads available.
  // Otherwise registers the header-injecting service worker and reloads (≤3 tries).
  async function ensureIsolated() {
    if (window.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
      try { sessionStorage.removeItem(COI_RELOAD_KEY); } catch (_) {}
      return true;
    }
    let attempts = 0;
    try { attempts = Number(sessionStorage.getItem(COI_RELOAD_KEY) || "0"); } catch (_) {}
    if (attempts >= 3) {
      log("Cross-origin isolation unavailable after " + attempts + " attempts.", "err");
      splashProgress(null, "");
      splashError("SharedArrayBuffer could not be enabled. This page needs COOP/COEP headers for the emulator's threads — serve the folder with server\\serve.py, or host it with those headers. Your page had " + attempts + " shim reload attempts.");
      return false;
    }
    if (!("serviceWorker" in navigator)) {
      splashError("SharedArrayBuffer is unavailable and service workers are disabled. Run server\\serve.py for local play.");
      return false;
    }
    let reg = null;
    try {
      reg = await navigator.serviceWorker.getRegistration("./");
      if (!reg?.active) {
        await navigator.serviceWorker.register("sw.js", { scope: "./" });
        await navigator.serviceWorker.ready;
      }
    } catch (e) {
      log("COI service worker registration failed: " + (e?.message || e), "err");
      splashError("Header shim could not start (" + (e?.message || e) + "). Run server\\serve.py for local play.");
      return false;
    }
    try { sessionStorage.setItem(COI_RELOAD_KEY, String(attempts + 1)); } catch (_) {}
    log("COI service worker active — reloading to pick up COOP/COEP headers.", "warn");
    location.reload();
    return false;
  }

  /* ── Library rendering ──────────────────────────────────────────── */

  async function renderLibrary() {
    const grid = byId("libraryGrid");
    const games = await libraryList();
    const rows = [];
    const coverUrlsToRevoke = [];
    const stemOf = (s) => s.toLowerCase().replace(/\.[^.]+$/, "");
    for (const g of games) {
      const meta = (await metaGet(g.path)) || { title: prettyName(g.path), format: (g.path.split(".").pop() || "?").toUpperCase() };
      let coverURL = "";
      const cover = await coverGet(g.path);
      if (cover?.length) {
        coverURL = URL.createObjectURL(new Blob([cover], { type: "image/png" }));
        coverUrlsToRevoke.push(coverURL);
      }
      const isCurrent = runtimeReady && currentGameStem === stemOf(g.path);
      rows.push(`
        <div class="lib-row">
          ${coverURL
            ? `<img class="lib-ico" src="${coverURL}" alt="">`
            : `<span class="lib-ico-ph">${esc((meta.title || "?").split(/\s+/).slice(0, 2).join(" "))}</span>`}
          <div class="lib-body">
            <div class="lib-name" title="${esc(g.path)}">${esc(meta.title || prettyName(g.path))}</div>
            <div class="lib-meta">${esc((meta.format || "?").toLowerCase())} · ${fmtBytes(g.size)}${isCurrent ? " · loaded" : ""}</div>
          </div>
          <div class="lib-act">
            <button data-act="play" data-id="${esc(g.path)}">${isCurrent ? "restart" : "play"}</button>
            <button class="btn danger" data-act="delete" data-id="${esc(g.path)}" title="remove from library">✕</button>
          </div>
        </div>`);
    }
    grid.innerHTML = rows.join("") || `<div class="empty">no games stored yet — import one with the load button, or boot with ?rom=&lt;url&gt;.</div>`;
    setTimeout(() => coverUrlsToRevoke.forEach((u) => URL.revokeObjectURL(u)), 4000);
    updateStorageLine();
  }

  async function addGameFromPicker(file) {
    toast("adding " + file.name + "…");
    try {
      await ensureOPFSOrWarn();
      const safe = safeName(file.name);
      await libraryPut(file.name, file);
      const doc = await extractGameMeta(file.name, file);
      log("Library: added " + safe + " (" + doc.title + ").", "ok");
      toast("✓ added: " + doc.title);
      await renderLibrary();
      if (runtimeReady && window.FS) {
        try {
          window.FS.mkdirTree(VIRTUAL_GAME_DIR);
          const bytes = new Uint8Array(await file.arrayBuffer());
          window.FS.writeFile(VIRTUAL_GAME_DIR + "/" + safe, bytes, { canOwn: true });
          window.Module?._PPSSPP_RefreshGameBrowser?.();
          toast("mounted for this session — play from the footer or library.");
        } catch (e) { log("Runtime mount failed: " + e.message, "warn"); }
      }
    } catch (e) {
      log("Add failed: " + e.message, "err");
      toast("✗ " + e.message);
    }
  }

  async function playGame(name) {
    // Persist whatever is fresh, then reload into this game.
    if (runtimeReady && window.FS) await persistFiles(window.FS, "before-restart");
    location.href = "./?play=" + encodeURIComponent(name);
  }

  async function removeGame(name) {
    const ok = await confirmDialog("remove " + name + " from the local library?\nthe disk image will be deleted from browser storage.");
    if (!ok) return;
    await libraryDelete(name);
    log("Library: removed " + name, "warn");
    toast("deleted " + name);
    await renderLibrary();
    if (runtimeReady && window.FS) {
      try { window.FS.unlink(VIRTUAL_GAME_DIR + "/" + safeName(name)); } catch (_) {}
      window.Module?._PPSSPP_RefreshGameBrowser?.();
    }
  }

  /* ── Save manager ───────────────────────────────────────────────── */

  function b64bytes(u8) {
    let bin = "";
    const n = 0x8000;
    for (let i = 0; i < u8.byteLength; i += n) bin += String.fromCharCode.apply(null, u8.subarray(i, i + n));
    return btoa(bin);
  }
  function bytesB64(str) { return Uint8Array.from(atob(str), (c) => c.charCodeAt(0)); }

  const SAVE_DIRS = [
    { dir: "PSP/SAVEDATA", flat: false, label: "Save Data" },
    { dir: "PSP/PPSSPP_STATE", flat: true, label: "Save States" },
  ];

  function gameIdFromStateFile(name) {
    const m = name.match(/^([A-Z]{4}\d{5}(?:_\d+\.?\d*)?)/i);
    return m ? m[1] : name.replace(/\.[^.]+$/, "");
  }

  async function refreshSaves() {
    const listEl = byId("savesList");
    const statsEl = byId("saveStats");
    const FS = window.FS;
    if (FS) void persistFiles(FS, "saves-view");
    const map = new Map(); // path → {size,data?,file,fromFS}
    // OPFS layer (last synced state)
    try {
      for (const e of await opfsWalk(OPFS_PERSIST_DIR, false)) map.set(e.path, { size: e.size, file: e.file, fromOPFS: true });
    } catch (_) {}
    // Live FS layer (freshest) — walk only the two save roots, not the whole config tree
    if (FS) {
      for (const root of PERSIST_ROOTS) {
        for (const { dir } of SAVE_DIRS) {
          try {
            for (const { path, data } of fsDataWalk(FS, root + "/" + dir)) map.set(path, { data, fromOPFS: false });
          } catch (_) {}
        }
      }
    }
    const slotsMap = new Map();
    for (const root of PERSIST_ROOTS) {
      for (const { dir, flat, label } of SAVE_DIRS) {
        const prefix = root + "/" + dir + "/";
        for (const [path, entry] of map) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          if (flat) {
            if (rest.includes("/")) continue;
            const game = gameIdFromStateFile(rest);
            const key = dir + "\0" + game;
            if (!slotsMap.has(key)) slotsMap.set(key, { dir, label, flat, game, files: [] });
            slotsMap.get(key).files.push({ name: rest, path, size: entry.file?.size || entry.data?.byteLength || 0, entry });
          } else {
            const slash = rest.indexOf("/");
            if (slash === -1) continue;
            const game = rest.slice(0, slash), fname = rest.slice(slash + 1);
            const key = dir + "\0" + game;
            if (!slotsMap.has(key)) slotsMap.set(key, { dir, label, flat, game, files: [] });
            slotsMap.get(key).files.push({ name: fname, path, size: entry.file?.size || entry.data?.byteLength || 0, entry });
          }
        }
      }
    }
    const slots = [...slotsMap.values()];
    let html = "";
    let totalSlots = 0, totalBytes = 0;
    for (const slot of slots.filter((s) => !s.flat)) {
      if (!slot.files.length) continue;
      const byName = (n) => slot.files.find((f) => f.name.toUpperCase() === n);
      const thumb = byName("ICON0.PNG") || byName("PIC1.PNG") || slot.files.find((f) => /\.png$/i.test(f.name)) || null;
      let thumbHTML = "";
      if (thumb) {
        try {
          const data = thumb.entry.data || new Uint8Array(await thumb.entry.file.arrayBuffer());
          thumbHTML = `<img class="save-ico" src="${URL.createObjectURL(new Blob([data], { type: "image/" + (thumb.name.split(".").pop().toLowerCase()) }))}" alt="">`;
        } catch (_) {}
      }
      const slotBytes = slot.files.reduce((s, f) => s + f.size, 0);
      totalSlots++; totalBytes += slotBytes;
      html += `<div class="save-row">
        ${thumbHTML || `<span class="save-ico ph"></span>`}
        <div class="save-body">
          <div class="save-name" title="${esc(slot.game)}">${esc(slot.game)}</div>
          <div class="save-meta">${slot.files.length} files · ${fmtBytes(slotBytes)}</div>
        </div>
        <div class="save-act">
          <button data-save="export" data-dir="${esc(slot.dir + "/" + slot.game)}" data-game="${esc(slot.game)}">export</button>
          <button class="btn danger" data-save="delete" data-dir="${esc(slot.dir + "/" + slot.game)}" data-game="${esc(slot.game)}">✕</button>
        </div>
      </div>`;
    }
    // Save states
    const stateSlots = slots.filter((s) => s.flat && s.files.length);
    for (const slot of stateSlots) {
      for (const f of slot.files) {
        if (/\.(ppst|jst|jpg|png)$/i.test(f.name) === false) continue;
        if (/\.(jpg|png)$/i.test(f.name)) continue;
        totalSlots++;
        const thumbFile = slot.files.find((x) => x.name.split(".")[0] === f.name.split(".")[0] && /\.(jpg|png)$/i.test(x.name));
        html += `<div class="save-row state">
          ${thumbFile ? "" : `<span class="save-ico ph"></span>`}
          <div class="save-body">
            <div class="save-name">${esc(f.name)}</div>
            <div class="save-meta">${fmtBytes(f.size)} · state</div>
          </div>
          <div class="save-act">
            <button data-save="export-file" data-path="${esc(f.path)}">export</button>
            <button class="btn danger" data-save="delete-pair" data-path="${esc(f.path)}" data-thumb="${thumbFile ? esc(thumbFile.path) : ""}">✕</button>
          </div>
        </div>`;
      }
    }

    if (!totalSlots) {
      listEl.innerHTML = `<div class="empty">no saves yet — save in-game (any slot/state) and it syncs here every 30 s.</div>`;
      statsEl.textContent = "";
    } else {
      listEl.innerHTML = html;
      statsEl.textContent = `${totalSlots} entr${totalSlots === 1 ? "y" : "ies"} · ${fmtBytes(totalBytes)} · last sync ${_lastPersist ? new Date(_lastPersist).toLocaleTimeString() : "pending"}`;
    }
  }

  async function exportSlot(slotPath, game) {
    const fileMap = new Map(); // dedupe: live FS wins over OPFS for the same path
    try {
      for (const e of await opfsWalk(OPFS_PERSIST_DIR, false))
        if (e.path.startsWith("/" + slotPath + "/")) fileMap.set(e.path, new Uint8Array(await e.file.arrayBuffer()));
    } catch (_) {}
    const FS = window.FS;
    if (FS) {
      try {
        for (const { path, data } of fsDataWalk(FS, memstickRoot + "/" + slotPath)) fileMap.set(path, data);
      } catch (_) {}
    }
    if (!fileMap.size) { toast("no files in that slot"); return; }
    const bundle = {
      version: 1,
      exported: new Date().toISOString(),
      slot: game,
      files: [...fileMap].map(([path, data]) => ({ path, name: path.split("/").pop(), data: b64bytes(data) })),
    };
    triggerDownload(new Blob([JSON.stringify(bundle)], { type: "application/json" }), "sg-slot-" + game.replace(/[^a-zA-Z0-9_-]/g, "_") + ".ppsspp");
    log("Exported slot " + game + " (" + fileMap.size + " files).", "ok");
  }

  async function exportSavePath(path) {
    let data = null;
    try { data = new Uint8Array(await (await opfsGetFile(path)).arrayBuffer()); } catch (_) {}
    if (!data && window.FS) { try { data = window.FS.readFile(path); } catch (_) {} }
    if (!data) { toast("file missing"); return; }
    triggerDownload(new Blob([data], { type: "application/octet-stream" }), path.split("/").pop());
  }

  async function importSavesBundleFile(file) {
    try {
      const bundle = JSON.parse(await file.text());
      if (!Array.isArray(bundle.files)) throw new Error("not a .ppsspp bundle");
      const FS = window.FS;
      let n = 0;
      for (const { path, data } of bundle.files) {
        const bytes = bytesB64(data);
        if (hasOPFS()) await opfsWrite(path.slice(1), bytes);
        if (FS) { try { fsMkdirP(FS, path.substring(0, path.lastIndexOf("/")) || "/"); FS.writeFile(path, bytes); } catch (_) {} }
        n++;
      }
      log("Imported " + n + " save files from " + file.name, "ok");
      toast("✓ imported " + n + " files");
      refreshSaves();
    } catch (e) {
      log("Import failed: " + e.message, "err");
      toast("✗ import failed: " + e.message);
    }
  }

  async function deletePathPair(path, thumbPath) {
    const ok = await confirmDialog("Delete " + path.split("/").pop() + (thumbPath ? " (+thumbnail)" : "") + "?\nThis cannot be undone.");
    if (!ok) return;
    try { await opfsDelete(path.slice(1)); } catch (_) {}
    if (thumbPath) { try { await opfsDelete(thumbPath.slice(1)); } catch (_) {} }
    const FS = window.FS;
    if (FS) { try { FS.unlink(path); } catch (_) {} if (thumbPath) { try { FS.unlink(thumbPath); } catch (_) {} } }
    toast("deleted");
    refreshSaves();
  }

  async function deleteSaveDir(slotPath, game) {
    const ok = await confirmDialog("Delete ALL saves under " + slotPath + " (game " + game + ")?\nThis cannot be undone.");
    if (!ok) return;
    try {
      for (const e of await opfsWalk(OPFS_PERSIST_DIR, false)) {
        if (e.path.startsWith("/" + slotPath + "/")) { await opfsDelete(e.path.slice(1)); }
      }
    } catch (_) {}
    if (window.FS) {
      try {
        const base = memstickRoot + "/" + slotPath;
        for (const { path } of fsDataWalk(window.FS, base)) { try { window.FS.unlink(path); } catch (_) {} }
        try { window.FS.rmdir(base); } catch (_) {}
      } catch (_) {}
    }
    toast("slot deleted");
    refreshSaves();
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /* ── Info panel ─────────────────────────────────────────────────── */

  let infoPanelTab = "";
  function infoRow(k, v, tone = "") { return `<div class="info-row"><span>${esc(k)}</span><span class="${tone}">${esc(v)}</span></div>`; }

  function updateInfo() {
    const grid = byId("infoGrid");
    if (!grid) return;
    const ctx = window.Module?.SDL2?.audioContext;
    const coi = window.crossOriginIsolated;
    const sab = typeof SharedArrayBuffer !== "undefined";
    const runtimeState = runtimeFailed ? "failed" : runtimeReady ? "running" : started ? "booting" : "idle";
    grid.innerHTML = [
      infoRow("shell", "ppsspp · webassembly"),
      infoRow("core revision", buildRevision || "unknown"),
      infoRow("runtime", runtimeState, runtimeReady ? "good" : runtimeFailed ? "bad" : ""),
      infoRow("audio", ctx ? ctx.state + " @ " + ctx.sampleRate + " hz" : "no context", ctx?.state === "running" ? "good" : "warn"),
      infoRow("gpu", gpuInfo.renderer || "probing…"),
      infoRow("webgl2", gpuInfo.webgl2 ? "yes" : "no", gpuInfo.webgl2 ? "good" : "bad"),
      infoRow("wasm simd", gpuInfo.simd ? "yes" : "no", gpuInfo.simd ? "good" : "warn"),
      infoRow("isolated (sab)", coi && sab ? "yes" : (sab ? "sab only" : "no"), coi && sab ? "good" : "bad"),
      infoRow("threads", String(navigator.hardwareConcurrency || "?")),
      infoRow("browser raf", runtimeReady ? fpsValue + " hz" : "—"),
      infoRow("memstick", runtimeReady ? memstickRoot : "—"),
      infoRow("last sync", _lastPersist ? new Date(_lastPersist).toLocaleTimeString() : "—"),
    ].join("");
  }

  // PPSSPP SDL (web build) default QWERTY keyboard mapping — from the core's
  // Common/KeyMap.cpp `defaultQwertyKeyboardKeyMap` (remappable in-game).
  const CONTROLS = [
    ["dpad", "arrow keys"],
    ["analog stick", "i / k · up/down"],
    ["analog stick", "j / l · left/right"],
    ["cross · circle", "z · x"],
    ["square · triangle", "a · s"],
    ["l / r triggers", "q · w"],
    ["start · select", "space · enter"],
    ["pause (in-game menu)", "esc"],
    ["hold fast-forward", "tab"],
    ["toggle speed", "` (backquote)"],
    ["rewind one step", "del (if enabled)"],
    ["rapid fire (hold)", "left shift"],
    ["precise analog (hold)", "right shift"],
  ];
  function renderControls() {
    const rows = CONTROLS.map(([a, b]) => `<div class="info-row"><span>${esc(a)}</span><span>${esc(b)}</span></div>`).join("");
    const boot = byId("bootControls");
    if (boot) boot.innerHTML = rows;
    const panel = byId("controls-table-panel");
    if (panel) panel.innerHTML = rows;
  }

  async function exportDiagnostics() {
    const report = {
      version: 1,
      created: new Date().toISOString(),
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: window.crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      opfs: hasOPFS(),
      buildRevision, gpu: gpuInfo, runtimeReady, started,
      lastPersist: _lastPersist,
      logs: logRing.slice(-400).map((l) => l.raw),
    };
    triggerDownload(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), "sg-recomp-diagnostics.json");
    toast("✓ diagnostics exported");
  }

  async function resetSettings() {
    if (runtimeFailed || !window.FS) { toast("not running — boot first."); return; }
    const ok = await confirmDialog("reset ppsspp settings to defaults?\ngames and saves are kept (each settings file is backed up).");
    if (!ok) return;
    try {
      await persistFiles(window.FS, "pre-reset");
      for (const e of await opfsWalk(OPFS_PERSIST_DIR, false)) {
        if (/\/PSP\/SYSTEM\/[^/]+\.ini$/i.test(e.path) && !/\/controls\.ini$/i.test(e.path)) {
          await opfsWrite(e.path.slice(1) + ".recovery-backup", await opfsRead(e.path));
          await opfsDelete(e.path.slice(1));
          try { window.FS.unlink(e.path); } catch (_) {}
          _persistedFingerprint.delete(e.path);
        }
      }
      toast("settings cleared — reload to start with ppsspp defaults.");
      log("Recovery: settings reset with backups.", "ok");
    } catch (e) { toast("reset failed: " + e.message); }
  }

  /* ── Worker compat (embedded shells block URL workers) ────────────
   * The core's pthread pool spawns dedicated workers from the glue URL.
   * Some sandboxed/preview environments refuse URL workers (instant empty
   * onerror) while allowing blob workers. Probe once; if blocked, rewrite
   * Worker so pthread workers get byte-exact blobs of the same script.
   * In normal browsers the probe passes and nothing changes. */
  let workerCompatDone = false;
  async function ensureWorkerCompat() {
    if (workerCompatDone) return;
    workerCompatDone = true;
    let ok;
    try {
      ok = await new Promise((res) => {
        let w;
        try {
          w = new Worker(BUILD_DIR + "PPSSPPSDL.js", { name: "em-probe" });
        } catch (_) { res(false); return; }
        const t = setTimeout(() => { try { w.terminate(); } catch (_) {} res(true); }, 1600);
        w.onerror = () => { clearTimeout(t); try { w.terminate(); } catch (_) {} res(false); };
      });
    } catch (_) { ok = false; }
    if (ok) return;
    try {
      const bytes = await (await fetch(new URL(BUILD_DIR + "PPSSPPSDL.js", location.href).href)).arrayBuffer();
      const blobURL = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
      const OrigWorker = self.Worker;
      self.Worker = function Worker(url, opts) {
        // the only Worker spawns in this build are the thread pool pointing at
        // the glue itself — always serve the identical bytes as a blob
        return new OrigWorker(blobURL, opts);
      };
      log("URL workers blocked here — using byte-exact blob workers for the thread pool.", "warn");
    } catch (e) {
      log("Worker compat patch failed: " + (e?.message || e), "warn");
    }
  }

  /* ── Fullscreen + footer behaviors ──────────────────────────────── */

  const fullscreenTarget = () => document.getElementById("stage") || document.documentElement;
  function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
  async function toggleFullscreen() {
    try {
      if (isFullscreen()) { await (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); }
      else {
        const target = fullscreenTarget();
        if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: "hide" });
        else target.webkitRequestFullscreen?.();
      }
    } catch (e) { log("Fullscreen failed: " + (e?.message || e), "warn"); }
  }
  document.addEventListener("fullscreenchange", () => {
    document.body.classList.toggle("fs", isFullscreen());
    renderLibrary();
  });

  // Cursor auto-hide in fullscreen
  let _cursorTimer = 0;
  function cursorInteract() {
    document.body.classList.remove("cursor-hidden");
    if (document.body.classList.contains("fs")) {
      clearTimeout(_cursorTimer);
      _cursorTimer = setTimeout(() => document.body.classList.add("cursor-hidden"), 2200);
    }
  }
  on(document, "mousemove", cursorInteract, { passive: true });

  /* ── Panel plumbing ─────────────────────────────────────────────── */

  let activeTab = "library";
  function openPanel(tab) {
    activeTab = tab || "library";
    document.body.classList.add("panel-open");
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === activeTab));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab" + activeTab[0].toUpperCase() + activeTab.slice(1)));
    onPanelShown();
  }
  function closePanel() {
    document.body.classList.remove("panel-open");
  }
  function onPanelShown() {
    if (activeTab === "library") renderLibrary();
    if (activeTab === "saves") refreshSaves();
    if (activeTab === "info") { updateInfo(); renderControls(); }
    if (activeTab === "log") renderLog();
  }
  on(document, "click", (e) => {
    const tab = e.target.closest?.(".tab");
    if (tab) openPanel(tab.dataset.tab);
  });
  on("panelclose", "click", closePanel);
  on("backdrop", "click", closePanel);
  on(window, "keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("panel-open")) { e.preventDefault(); closePanel(); }
  });

  on("footPlay", "click", () => openPanel("library"));
  on("footLoad", "click", () => byId("gameFile").click());
  on("footSaves", "click", () => openPanel("saves"));
  on("footInfo", "click", () => openPanel("info"));
  on("footFull", "click", () => toggleFullscreen());
  on("footExit", "click", async () => {
    const ok = await confirmDialog("exit to the main menu?\nin-game progress keeps syncing every 30 s; recent actions save on next sync.");
    if (!ok) return;
    if (runtimeReady && window.FS) await persistFiles(window.FS, "exit");
    location.href = "./?menu=1";
  });
  on("gameFile", "change", (e) => {
    const f = e.target.files?.[0];
    if (f) addGameFromPicker(f);
    e.target.value = "";
  });
  on("libraryAddBtn", "click", () => byId("gameFile").click());
  on("libraryGrid", "click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === "play") playGame(id);
    if (btn.dataset.act === "delete") removeGame(id);
  });

  on("syncSavesBtn", "click", async () => {
    if (!window.FS) { toast("the ppsspp core is not running yet"); return; }
    await persistFiles(window.FS, "manual");
    toast("✓ synced");
    refreshSaves();
  });
  on("exportSavesBtn", "click", async () => {
    const FS = window.FS;
    if (FS) await persistFiles(FS, "export");
    const bundle = { version: 1, exported: new Date().toISOString(), files: [] };
    for (const e of await opfsWalk(OPFS_PERSIST_DIR, true)) {
      if (!e.data) e.data = new Uint8Array(await e.file.arrayBuffer());
      bundle.files.push({ path: e.path, name: e.name, data: b64bytes(e.data) });
    }
    if (!bundle.files.length) { toast("no save data to export yet"); return; }
    triggerDownload(new Blob([JSON.stringify(bundle)], { type: "application/json" }), "sg-recomp-saves-" + new Date().toISOString().slice(0, 10) + ".ppsspp");
    log("Exported full save bundle (" + bundle.files.length + " files).", "ok");
  });
  on("importSavesBtn", "click", () => byId("importSavesFile").click());
  on("importSavesFile", "change", (e) => { const f = e.target.files?.[0]; if (f) importSavesBundleFile(f); e.target.value = ""; });
  on("savesList", "click", async (e) => {
    const btn = e.target.closest("button[data-save]");
    if (!btn) return;
    const kind = btn.dataset.save;
    if (kind === "export") exportSlot(btn.dataset.dir, btn.dataset.game);
    else if (kind === "delete") deleteSaveDir(btn.dataset.dir, btn.dataset.game);
    else if (kind === "export-file") exportSavePath(btn.dataset.path);
    else if (kind === "delete-pair") deletePathPair(btn.dataset.path, btn.dataset.thumb || "");
  });

  on("diagnosticsBtn", "click", exportDiagnostics);
  on("resetSettingsBtn", "click", resetSettings);
  on("logFilter", "input", renderLog);

  /* ── Auto boot ──────────────────────────────────────────────────── */

  async function beginBoot(plan) {
    if (started) return;
    byId("boot").classList.add("booting");
    await startSession(plan);
  }

  /* ── Main init ──────────────────────────────────────────────────── */

  async function main() {
    try {
      log("Shell start. crossOriginIsolated=" + window.crossOriginIsolated, window.crossOriginIsolated ? "ok" : "warn");
      if (!(await ensureIsolated())) return;

      probeGPU();
      renderControls();
      await loadBuildInfo();
      beginBoot(await resolveBootGame());
    } catch (e) {
      failRuntime("init failed: " + (e?.stack || e?.message || e));
    }
  }

  // Boot on DOM ready (script is at end of body; safe to run now)
  void main();

  // Expose tiny handles for in-page debugging / theme use
  window.sg = {
    log, toast,
    persistFiles: () => (window.FS ? persistFiles(window.FS, "manual") : null),
    boot: () => resolveBootGame().then(startSession), // debug re-boot (no reload)
  };
})();
