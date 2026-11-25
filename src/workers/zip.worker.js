/**
 * Dedicated Web Worker for client-side batch ZIP packaging via fflate.
 * Uses zero-copy Transferable ArrayBuffers and returns a structured envelope.
 */

import { zipSync } from 'fflate';

/**
 * Deduplicate filenames inside the archive while preserving extensions.
 * @param {string} rawName
 * @param {Set<string>} usedNames
 * @returns {string}
 */
function deduplicateName(rawName, usedNames) {
  if (!usedNames.has(rawName)) {
    usedNames.add(rawName);
    return rawName;
  }

  const dotIdx = rawName.lastIndexOf('.');
  const base = dotIdx > 0 ? rawName.slice(0, dotIdx) : rawName;
  const ext = dotIdx > 0 ? rawName.slice(dotIdx) : '';

  let counter = 1;
  let candidate = `${base} (${counter})${ext}`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${base} (${counter})${ext}`;
  }
  usedNames.add(candidate);
  return candidate;
}

self.addEventListener('message', (event) => {
  const { jobId, entries } = event.data || {};
  if (!jobId || !Array.isArray(entries)) return;

  try {
    /** @type {Record<string, Uint8Array>} */
    const archiveMap = {};
    const usedNames = new Set();

    for (const entry of entries) {
      const safeName = deduplicateName(entry.name, usedNames);
      archiveMap[safeName] = new Uint8Array(entry.buffer);
    }

    // level: 0 (store) since JPEG/PNG/WebP/AVIF payloads are already compressed
    const zipped = zipSync(archiveMap, { level: 0 });
    const zipBuffer =
      zipped.byteOffset === 0 && zipped.byteLength === zipped.buffer.byteLength
        ? zipped.buffer
        : zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);

    self.postMessage(
      {
        jobId,
        ok: true,
        result: { zipBuffer },
      },
      [zipBuffer]
    );
  } catch (err) {
    self.postMessage({
      jobId,
      ok: false,
      error: {
        code: 'ZIP_ERROR',
        message: err instanceof Error ? err.message : 'Failed to build ZIP archive.',
      },
    });
  }
});
