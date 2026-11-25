/**
 * Magic-byte MIME detection for supported image formats.
 * Never trusts file.type or filename extensions alone.
 */

/** @typedef {'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'} SupportedMime */

const HEADER_SLICE_BYTES = 16;

/**
 * Detect image MIME type from a binary buffer using magic bytes.
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {SupportedMime | null}
 */
export function sniffBufferMime(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 12) {
    return null;
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: "RIFF" at 0 and "WEBP" at 8
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  // AVIF: "ftyp" at 4 and "avif" or "avis" at 8
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70 &&
    bytes[8] === 0x61 &&
    bytes[9] === 0x76 &&
    bytes[10] === 0x69 &&
    (bytes[11] === 0x66 || bytes[11] === 0x73)
  ) {
    return 'image/avif';
  }

  return null;
}

/**
 * Read only the first 16 bytes of a File/Blob and verify its magic signature.
 * @param {Blob} file
 * @returns {Promise<SupportedMime | null>}
 */
export async function sniffFileMime(file) {
  const headerBuffer = await file.slice(0, HEADER_SLICE_BYTES).arrayBuffer();
  return sniffBufferMime(headerBuffer);
}

/**
 * Return standard lowercase file extension for a supported MIME type.
 * @param {string} mime
 * @returns {string}
 */
export function mimeToExtension(mime) {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/avif':
      return 'avif';
    default:
      return 'bin';
  }
}

/**
 * Return short human-readable format badge label.
 * @param {string} mime
 * @returns {string}
 */
export function formatMimeLabel(mime) {
  switch (mime) {
    case 'image/jpeg':
      return 'JPEG';
    case 'image/png':
      return 'PNG';
    case 'image/webp':
      return 'WebP';
    case 'image/avif':
      return 'AVIF';
    default:
      return 'Unknown';
  }
}
