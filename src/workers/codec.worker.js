/**
 * Dedicated Web Worker for EXIF inspection and dual-path image optimization:
 * - Path A: Lossless binary metadata stripping (JPEG, PNG, WebP)
 * - Path B: Browser/Wasm decode -> @jsquash/resize (Lanczos3) -> lazy Wasm encode
 *
 * Always enforces single-threaded Wasm fallback when crossOriginIsolated === false.
 * Every response returns { jobId, revision, ok, result | error }.
 */

import { parseExifSummary } from '../core/exif-reader.js';
import {
  extractJpegApp1,
  injectJpegApp1,
  stripMetadataBuffer,
} from '../core/exif-stripper.js';

/** @type {Promise<unknown> | null} */
let avifEncoderPromise = null;

/**
 * Compute aspect-preserving target dimensions without upscaling.
 * @param {number} width
 * @param {number} height
 * @param {number} maxWidth
 * @param {number} maxHeight
 * @returns {{ width: number, height: number, resized: boolean }}
 */
function computeTargetDimensions(width, height, maxWidth, maxHeight) {
  let targetW = width;
  let targetH = height;

  const hasMaxW = typeof maxWidth === 'number' && maxWidth > 0;
  const hasMaxH = typeof maxHeight === 'number' && maxHeight > 0;

  if (!hasMaxW && !hasMaxH) {
    return { width, height, resized: false };
  }

  let scale = 1;
  if (hasMaxW && width > maxWidth) {
    scale = Math.min(scale, maxWidth / width);
  }
  if (hasMaxH && height > maxHeight) {
    scale = Math.min(scale, maxHeight / height);
  }

  if (scale >= 1) {
    return { width, height, resized: false };
  }

  targetW = Math.max(1, Math.round(width * scale));
  targetH = Math.max(1, Math.round(height * scale));
  return { width: targetW, height: targetH, resized: true };
}

/**
 * Decode an encoded image buffer into raw RGBA ImageData.
 * Uses createImageBitmap + OffscreenCanvas with immediate bitmap.close(),
 * falling back to Wasm decoders for AVIF or unsupported bitmaps.
 * @param {ArrayBuffer} buffer
 * @param {string} mime
 * @returns {Promise<ImageData>}
 */
async function decodeToImageData(buffer, mime) {
  if (mime === 'image/avif') {
    const { default: avifDecode } = await import('@jsquash/avif/decode.js');
    return avifDecode(buffer);
  }

  const blob = new Blob([buffer], { type: mime });
  /** @type {ImageBitmap | null} */
  let bitmap = null;

  try {
    bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to create OffscreenCanvas 2D context.');
    }
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  } catch {
    // Fallback to Wasm decoders if browser decode fails
    if (mime === 'image/jpeg') {
      const { default: jpegDecode } = await import('@jsquash/jpeg/decode.js');
      return jpegDecode(buffer);
    }
    if (mime === 'image/png') {
      const { default: pngDecode } = await import('@jsquash/png/decode.js');
      return pngDecode(buffer);
    }
    if (mime === 'image/webp') {
      const { default: webpDecode } = await import('@jsquash/webp/decode.js');
      return webpDecode(buffer);
    }
    throw new Error(`Unable to decode image of type ${mime}`);
  } finally {
    if (bitmap) {
      bitmap.close();
    }
  }
}

/**
 * Lazily initialize the AVIF encoder with an explicit single-threaded fallback
 * when self.crossOriginIsolated is false or SharedArrayBuffer is unavailable.
 * @returns {Promise<any>}
 */
async function getAvifEncoderModule() {
  if (avifEncoderPromise) return avifEncoderPromise;

  const canUseThreads =
    self.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';

  if (canUseThreads) {
    avifEncoderPromise = (async () => {
      const mod = await import('@jsquash/avif/encode.js');
      return { type: 'wrapper', encode: mod.default };
    })();
  } else {
    // Explicit single-threaded Wasm path without SharedArrayBuffer/pthreads
    avifEncoderPromise = (async () => {
      const [{ default: avifEncFactory }, { initEmscriptenModule }, { defaultOptions }] =
        await Promise.all([
          import('@jsquash/avif/codec/enc/avif_enc.js'),
          import('@jsquash/avif/utils.js'),
          import('@jsquash/avif/meta.js'),
        ]);
      const module = await initEmscriptenModule(avifEncFactory);
      return {
        type: 'raw',
        encode: (imageData, options) => {
          const merged = { ...defaultOptions, ...options };
          const out = module.encode(
            imageData.data,
            imageData.width,
            imageData.height,
            merged
          );
          if (!out) throw new Error('AVIF encoding failed.');
          return out.buffer;
        },
      };
    })();
  }

  return avifEncoderPromise;
}

/**
 * Encode ImageData into the target format using lazy-loaded @jsquash Wasm codecs.
 * @param {ImageData} imageData
 * @param {string} targetMime
 * @param {number} quality
 * @returns {Promise<ArrayBuffer>}
 */
async function encodeImageData(imageData, targetMime, quality) {
  const clampedQuality = Math.max(1, Math.min(100, Math.round(quality)));

  switch (targetMime) {
    case 'image/jpeg': {
      const { default: jpegEncode } = await import('@jsquash/jpeg/encode.js');
      return jpegEncode(imageData, {
        quality: clampedQuality,
        progressive: true,
        optimize_coding: true,
      });
    }
    case 'image/png': {
      const { default: pngEncode } = await import('@jsquash/png/encode.js');
      return pngEncode(imageData);
    }
    case 'image/webp': {
      const { default: webpEncode } = await import('@jsquash/webp/encode.js');
      return webpEncode(imageData, {
        quality: clampedQuality,
        lossless: clampedQuality === 100 ? 1 : 0,
      });
    }
    case 'image/avif': {
      const encoder = await getAvifEncoderModule();
      const cqLevel = Math.round(((100 - clampedQuality) / 100) * 63);
      return encoder.encode(imageData, { cqLevel, speed: 6 });
    }
    default:
      throw new Error(`Unsupported target output format: ${targetMime}`);
  }
}

/**
 * Ensure returned buffer is an unshared, tightly sized ArrayBuffer ready for transfer.
 * @param {ArrayBufferLike} bufferLike
 * @returns {ArrayBuffer}
 */
function ensureTransferableArrayBuffer(bufferLike) {
  if (bufferLike instanceof ArrayBuffer) {
    return bufferLike;
  }
  const copy = new Uint8Array(bufferLike.byteLength);
  copy.set(new Uint8Array(bufferLike));
  return copy.buffer;
}

/**
 * Handle an EXIF inspection job on a 128 KB partial header buffer.
 * @param {{ jobId: string, revision: number, buffer: ArrayBuffer }} payload
 */
async function handleInspect(payload) {
  const { jobId, revision, buffer } = payload;
  try {
    const exifData = await parseExifSummary(buffer);
    self.postMessage({
      jobId,
      revision,
      ok: true,
      result: { exifData },
    });
  } catch (err) {
    self.postMessage({
      jobId,
      revision,
      ok: false,
      error: {
        code: 'EXIF_PARSE_ERROR',
        message: err instanceof Error ? err.message : 'Failed to parse EXIF metadata.',
      },
    });
  }
}

/**
 * Handle an image optimization job (Path A lossless strip OR Path B Wasm pipeline).
 * @param {{
 *   jobId: string,
 *   revision: number,
 *   buffer: ArrayBuffer,
 *   mime: string,
 *   settings: import('../state/store.js').PixnifySettings
 * }} payload
 */
async function handleProcess(payload) {
  const { jobId, revision, buffer, mime, settings } = payload;
  const startedAt = performance.now();

  try {
    // Path A: Lossless binary EXIF/Metadata Stripper
    if (settings.mode === 'strip') {
      const stripped = stripMetadataBuffer(buffer, mime, {
        keepIcc: settings.keepIcc,
      });
      const outBuffer = ensureTransferableArrayBuffer(stripped.buffer);
      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));

      self.postMessage(
        {
          jobId,
          revision,
          ok: true,
          result: {
            outputBuffer: outBuffer,
            outputMime: mime,
            originalWidth: null,
            originalHeight: null,
            width: null,
            height: null,
            method: 'lossless-strip',
            removedSegments: stripped.removedSegments,
            durationMs,
          },
        },
        [outBuffer]
      );
      return;
    }

    // Path B: Decode -> Optional Lanczos Resize -> Wasm Encode
    const outMime =
      settings.targetFormat === 'original' ? mime : settings.targetFormat;

    const preservedApp1 =
      !settings.stripMetadata && mime === 'image/jpeg' && outMime === 'image/jpeg'
        ? extractJpegApp1(buffer)
        : null;

    let imageData = await decodeToImageData(buffer, mime);
    const originalWidth = imageData.width;
    const originalHeight = imageData.height;

    const targetDims = computeTargetDimensions(
      originalWidth,
      originalHeight,
      settings.maxWidth,
      settings.maxHeight
    );

    if (targetDims.resized) {
      const { default: resizeImage } = await import('@jsquash/resize');
      imageData = await resizeImage(imageData, {
        width: targetDims.width,
        height: targetDims.height,
        method: 'lanczos3',
      });
    }

    let encodedBuffer = await encodeImageData(
      imageData,
      outMime,
      settings.quality
    );

    if (preservedApp1) {
      encodedBuffer = injectJpegApp1(encodedBuffer, preservedApp1);
    }

    const outBuffer = ensureTransferableArrayBuffer(encodedBuffer);
    const durationMs = Math.max(1, Math.round(performance.now() - startedAt));

    self.postMessage(
      {
        jobId,
        revision,
        ok: true,
        result: {
          outputBuffer: outBuffer,
          outputMime: outMime,
          originalWidth,
          originalHeight,
          width: imageData.width,
          height: imageData.height,
          method: 'wasm-transcode',
          removedSegments: settings.stripMetadata ? ['EXIF', 'XMP', 'IPTC'] : [],
          durationMs,
        },
      },
      [outBuffer]
    );
  } catch (err) {
    self.postMessage({
      jobId,
      revision,
      ok: false,
      error: {
        code: 'PROCESS_ERROR',
        message: err instanceof Error ? err.message : 'Image processing failed.',
      },
    });
  }
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || !message.type) return;

  if (message.type === 'inspect') {
    handleInspect(message);
  } else if (message.type === 'process') {
    handleProcess(message);
  }
});
