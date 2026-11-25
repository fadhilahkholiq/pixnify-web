# Pixnify

**Pixnify** is a 100% client-side, zero-server **Local Image & EXIF Optimizer** built with Vanilla JavaScript, Browser APIs, and WebAssembly. All image decoding, compression, resizing, EXIF metadata inspection, and batch ZIP archiving run locally inside your browser—your files never leave your device.

---

## Key Features

- **Dual-Path Processing Engine**
  - **Compress & Convert:** Decodes images via `createImageBitmap` / `OffscreenCanvas` (or Wasm decoders), applies optional Lanczos3 downscaling (`@jsquash/resize`), and re-encodes with WebAssembly codecs:
    - **JPEG** via `@jsquash/jpeg` (MozJPEG, progressive + coding optimization)
    - **PNG** via `@jsquash/png` (lossless)
    - **WebP** via `@jsquash/webp` (libwebp, lossy or lossless at quality 100)
    - **AVIF** via `@jsquash/avif` (libavif, with automatic single-threaded fallback when `crossOriginIsolated` is `false`)
  - **Strip Metadata Only (Lossless):** Performs byte-level `DataView` binary stripping (`src/core/exif-stripper.js`) without decoding or re-encoding pixel data:
    - **JPEG:** Removes `APP1` (EXIF/XMP), `APP13` (IPTC/Photoshop), `COM` comments, and auxiliary `APPn` segments while keeping entropy scan data untouched (with optional `APP2` ICC retention).
    - **PNG:** Strips `eXIf`, `tEXt`, `zTXt`, `iTXt`, and `tIME` chunks while preserving `IHDR`, `PLTE`, `IDAT`, `IEND`, and color chunks (`sRGB`, `iCCP`, `gAMA`).
    - **WebP:** Strips `EXIF` and `XMP ` RIFF chunks, updates `VP8X` feature flags, and recalculates the root RIFF container size.
- **Magic-Byte Format Validation:** Reads only the first 16 bytes (`src/core/file-sniffer.js`) to verify authentic JPEG, PNG, WebP, and AVIF signatures regardless of filename extension.
- **128 KB Partial-Slice EXIF Inspector:** Parses only the first 128 KB (`src/core/exif-reader.js` using `exifr`) inside a Web Worker and classifies tags into three privacy risk tiers (**High Risk**, **Medium**, **Technical**), with interactive filtering in the inspector drawer.
- **Bounded Worker Pool & Cancellation:** Caps Web Workers at `min(navigator.hardwareConcurrency || 4, 4)` (`src/workers/worker-pool.js`), uses zero-copy transferable `ArrayBuffer`s, and cancels stale queued/in-flight jobs via monotonically increasing `revision` tokens whenever settings change.
- **Interactive Workflows:** Supports drag-and-drop, native file picker, clipboard paste (`Ctrl+V` / `⌘+V`), live batch savings progress, split-slider visual comparison modal, single-file download, and off-thread batch ZIP export via `fflate` (`src/workers/zip.worker.js`).

---

## Tech Stack

- **Language & Build:** Vanilla JavaScript (ES Modules + JSDoc), Vite (`worker: { format: 'es' }`)
- **WebAssembly Codecs:** `@jsquash/jpeg`, `@jsquash/png`, `@jsquash/webp`, `@jsquash/avif`, `@jsquash/resize`
- **Metadata & Archiving:** `exifr`, `fflate`

---

## Project Structure

```text
pixnify/
├── index.html                 # Single-page entry point & SEO metadata
├── package.json               # Dependencies and Vite scripts
├── vite.config.js             # Vite config (ES workers, @jsquash optimizeDeps exclusions, COOP/COEP)
├── vercel.json                # Vercel headers, Wasm MIME & immutable caching
├── public/
│   ├── _headers               # Cloudflare Pages headers, Wasm MIME & COOP/COEP
│   ├── favicon.svg            # Monochrome vector favicon
│   └── robots.txt             # Search crawler configuration
└── src/
    ├── main.js                # App bootstrap, worker dispatch & lifecycle cleanup
    ├── state/
    │   └── store.js           # Reactive state store (File handles, Blob/ObjectURL lifecycle)
    ├── core/
    │   ├── file-sniffer.js    # 16-byte magic-byte MIME detection
    │   ├── exif-reader.js     # 128 KB partial-slice EXIF/GPS/XMP parser & risk classifier
    │   └── exif-stripper.js   # Lossless binary metadata stripper (JPEG, PNG, WebP)
    ├── workers/
    │   ├── worker-pool.js     # Bounded Web Worker pool & revision-based cancellation
    │   ├── codec.worker.js    # EXIF inspection + dual-path optimization worker
    │   └── zip.worker.js      # Client-side fflate batch ZIP archive generator
    ├── ui/
    │   ├── dropzone.js        # Drag-and-drop, file picker & clipboard paste
    │   ├── queue-list.js      # Batch stats, progress bar, item cards & downloads
    │   ├── exif-drawer.js     # Slide-over EXIF privacy inspector & tier filters
    │   └── compare-modal.js   # Interactive split-slider visual quality comparison
    └── styles/
        └── main.css           # Design tokens, layout & responsive styles
```

---

## Getting Started

### Prerequisites

- **Node.js** 18+ (tested with Node 21) and **npm**

### Installation & Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:5173/` in your browser. Both `vite` dev and `vite preview` serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` headers so multi-threaded Wasm codecs (`SharedArrayBuffer`) are available where supported, while falling back cleanly to single-threaded Wasm when cross-origin isolation is disabled.

### Production Build & Preview

```bash
npm run build
npm run preview
```

The static production bundle is emitted to `dist/`.

---

## Static Deployment

Pixnify requires no backend server and is pre-configured for static edge hosting:

- **Cloudflare Pages:** Deploy the `dist/` output directory. [public/_headers](./public/_headers) configures `application/wasm` MIME types, immutable caching for `/assets/*.wasm` and `/assets/*.js`, and `COOP`/`COEP: credentialless`. All individual `.wasm` assets are under the 25 MiB Cloudflare Pages single-file limit.
- **Vercel:** [vercel.json](./vercel.json) configures security headers, `COOP`/`COEP: credentialless`, and `application/wasm` caching headers automatically.

---

## Privacy & Architecture Invariants

- **Zero Network Calls for User Data:** No user images, filenames, or EXIF payloads are ever transmitted over the network.
- **Memory Hygiene:** `ImageBitmap.close()` is called immediately in `try/finally` blocks after pixel extraction, and `URL.revokeObjectURL()` is paired with every item removal, replacement, settings revision bump, batch ZIP download, and page unload.
