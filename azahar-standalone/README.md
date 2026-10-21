# Azahar — 3DS Emulator (Standalone)

A minimal 3DS emulator that runs on any static web host. Drop in a ROM (or
pass a URL) and play.

## Quick start

```bash
cd azahar-standalone
python3 -m http.server 8000
```

Then open in Chrome/Edge:
- **Local ROM:** place `rom.cci` in the folder → open `http://localhost:8000/`
- **ROM by filename:** `http://localhost:8000/?rom=mygame.3ds`
- **ROM by URL:** `http://localhost:8000/?rom=https://example.com/game.3ds`

First load registers a service worker and reloads once to enable cross-origin
isolation. After that, the game starts automatically.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Minimal UI: title + loading bar (hidden when game runs) |
| `app.js` | Loader: SW → fetch ROM → init WebGL2 → autostart |
| `coi-serviceworker.js` | Injects COOP/COEP headers (no server config needed) |
| `azahar_webgl2.js` | Emscripten glue (Shubin123 WebGL2 build, GPL-2.0+) |
| `azahar_webgl2.wasm` | Compiled Azahar WebAssembly binary (GPU renderer) |
| `README.md` | This file |

## ROM loading

The loader tries these sources in order:

1. **`?rom=<absolute URL>`** — fetches the ROM from that URL and caches it in
   IndexedDB. Next time you open the same URL, it loads instantly from cache
   without re-downloading.
2. **`?rom=<filename>`** — fetches `./<filename>` from the same directory.
3. **No `?rom`** — tries `rom.cci`, `rom.3ds`, `rom.cxi`, `rom.app`, `rom.cfa`,
   `rom.3dsx`, `rom.elf`, then `game.*` variants.

## Supported formats

| Format | Extensions |
|--------|-----------|
| NCSD (CCI) | `.3ds`, `.cci`, `.zcci` |
| NCCH (CXI) | `.cxi`, `.app`, `.zcxi` |
| NCCH (CFA) | `.cfa` |
| 3DSX | `.3dsx`, `.z3dsx` |
| ELF | `.elf`, `.axf` |
| CIA | ❌ Not supported — decrypt first |

**CIAs must be decrypted before use.** Use
[Batch CIA 3DS Decryptor Redux](https://github.com/xxmichibxx/Batch-CIA-3DS-Decryptor-Redux)
to convert `.cia` → `.cci`.

## Controls

Hardcoded in the engine (SDL2 default profile):

| 3DS | Keyboard |
|-----|----------|
| Circle Pad | Arrow keys |
| D-Pad | T G F H (Up Down Left Right) |
| A / B / X / Y | A / S / Z / X |
| L / R | Q / W |
| ZL / ZR | 1 / 2 |
| Start / Select | M / N |
| Home | B |

Click the game canvas first if keys don't respond.

## How it works

```
index.html → app.js
  ├── 1. Register coi-serviceworker.js → COOP/COEP headers → crossOriginIsolated
  ├── 2. Fetch ROM (?rom=<url> with IndexedDB cache, or same-directory)
  ├── 3. Load azahar_webgl2.js → window.Module (768 MB → 4 GB memory)
  ├── 4. _azahar_init() → WebGL2 renderer + Core::System
  ├── 5. FS.writeFile("rom.cci", bytes) → ccall("azahar_load_rom")
  ├── 6. Hide boot screen, show canvas
  └── 7. requestAnimationFrame loop → _azahar_step_frame()
         (SDL2 reads keyboard directly inside the WASM)
```

## Troubleshooting

**"No ROM found"** — place `rom.cci` in the folder or use `?rom=<url>`.

**"Service workers not supported"** — use `http://` or `https://`, not `file://`.

**"WebGL2 not available"** — enable hardware acceleration in your browser,
or try Chrome/Edge. On Windows, launch Chrome with `--use-angle=vulkan`
for best performance.

**"ROM is encrypted"** — use a decrypted `.cci`/`.3ds` file. For CIAs,
decrypt with Batch CIA 3DS Decryptor Redux first.

**Page reloads once on first visit** — that's the service worker activating.
Only happens once.

## Licensing

- `azahar_webgl2.js` and `azahar_webgl2.wasm` are from the
  [Azahar emulator](https://github.com/azahar-emu/azahar) compiled by
  [Shubin123/azahar_web](https://github.com/Shubin123/azahar_web),
  licensed under **GPL-2.0-or-later**.
- `coi-serviceworker.js` is based on
  [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker), **MIT**.
- `index.html`, `app.js`, and `README.md` are **MIT**.

3DS and Nintendo are trademarks of Nintendo. This project is not affiliated
with Nintendo. Users are responsible for legally obtaining ROMs.
