/**
 * Lossless byte-level binary metadata stripper (DataView).
 * Removes EXIF, GPS, XMP, IPTC, and comments from JPEG, PNG, and WebP
 * without decoding or re-encoding pixel data.
 */

/**
 * @typedef {Object} StripResult
 * @property {ArrayBuffer} buffer
 * @property {number} strippedBytes
 * @property {string[]} removedSegments
 */

/**
 * Concatenate an array of Uint8Array slices into a single tight ArrayBuffer.
 * @param {Uint8Array[]} parts
 * @returns {ArrayBuffer}
 */
function concatUint8Arrays(parts) {
  let totalLength = 0;
  for (const part of parts) {
    totalLength += part.byteLength;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result.buffer;
}

/**
 * Losslessly strip metadata markers from a JPEG buffer.
 * Preserves SOF, DHT, DQT, DRI, SOS entropy scan data, and optionally APP2 (ICC).
 * @param {ArrayBuffer} inputBuffer
 * @param {{ keepIcc?: boolean }} [options]
 * @returns {StripResult}
 */
export function stripJpegMetadata(inputBuffer, options = {}) {
  const { keepIcc = true } = options;
  const bytes = new Uint8Array(inputBuffer);
  const view = new DataView(inputBuffer);

  if (bytes.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) {
    throw new Error('Invalid JPEG stream: missing SOI marker.');
  }

  /** @type {Uint8Array[]} */
  const kept = [bytes.subarray(0, 2)];
  /** @type {string[]} */
  const removedSegments = [];
  let offset = 2;

  while (offset < bytes.byteLength) {
    // Skip fill bytes before marker
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) {
      offset += 1;
    }
    while (offset + 1 < bytes.byteLength && bytes[offset + 1] === 0xff) {
      offset += 1;
    }
    if (offset + 1 >= bytes.byteLength) break;

    const marker = view.getUint16(offset, false);

    // Standalone markers without length field (RST0..RST7, TEM, SOI, EOI)
    if (
      marker === 0xff01 ||
      (marker >= 0xffd0 && marker <= 0xffd9)
    ) {
      kept.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      if (marker === 0xffd9) break; // EOI
      continue;
    }

    // Start of Scan (SOS): copy SOS header and all remaining scan bytes verbatim
    if (marker === 0xffda) {
      kept.push(bytes.subarray(offset));
      break;
    }

    if (offset + 4 > bytes.byteLength) {
      throw new Error('Truncated JPEG segment header.');
    }

    const segmentLength = view.getUint16(offset + 2, false);
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.byteLength) {
      throw new Error('Corrupted JPEG segment length.');
    }

    const segmentEnd = offset + 2 + segmentLength;

    const isApp1 = marker === 0xffe1; // EXIF / XMP
    const isApp13 = marker === 0xffed; // IPTC / Photoshop
    const isCom = marker === 0xfffe; // Comment
    const isApp2 = marker === 0xffe2; // ICC_Profile
    const isOtherApp =
      marker >= 0xffe3 &&
      marker <= 0xffef &&
      marker !== 0xffee; // Keep APP0 (JFIF) & APP14 (Adobe); drop auxiliary APPn

    const shouldStrip =
      isApp1 ||
      isApp13 ||
      isCom ||
      (isApp2 && !keepIcc) ||
      isOtherApp;

    if (shouldStrip) {
      removedSegments.push(`0x${marker.toString(16).toUpperCase()}`);
    } else {
      kept.push(bytes.subarray(offset, segmentEnd));
    }

    offset = segmentEnd;
  }

  const outBuffer = concatUint8Arrays(kept);
  return {
    buffer: outBuffer,
    strippedBytes: Math.max(0, inputBuffer.byteLength - outBuffer.byteLength),
    removedSegments,
  };
}

/**
 * Losslessly strip metadata chunks (eXIf, tEXt, zTXt, iTXt, tIME) from a PNG buffer.
 * @param {ArrayBuffer} inputBuffer
 * @param {{ keepIcc?: boolean }} [options]
 * @returns {StripResult}
 */
export function stripPngMetadata(inputBuffer, options = {}) {
  const { keepIcc = true } = options;
  const bytes = new Uint8Array(inputBuffer);
  const view = new DataView(inputBuffer);

  if (bytes.byteLength < 8) {
    throw new Error('Invalid PNG stream: file too short.');
  }

  const STRIP_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
  if (!keepIcc) {
    STRIP_CHUNKS.add('iCCP');
  }

  /** @type {Uint8Array[]} */
  const kept = [bytes.subarray(0, 8)];
  /** @type {string[]} */
  const removedSegments = [];
  let offset = 8;

  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = view.getUint32(offset, false);
    const totalChunkSize = 12 + chunkLength;
    if (offset + totalChunkSize > bytes.byteLength) {
      throw new Error('Truncated PNG chunk.');
    }

    const chunkType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );

    if (STRIP_CHUNKS.has(chunkType)) {
      removedSegments.push(chunkType);
    } else {
      kept.push(bytes.subarray(offset, offset + totalChunkSize));
    }

    offset += totalChunkSize;
    if (chunkType === 'IEND') break;
  }

  const outBuffer = concatUint8Arrays(kept);
  return {
    buffer: outBuffer,
    strippedBytes: Math.max(0, inputBuffer.byteLength - outBuffer.byteLength),
    removedSegments,
  };
}

/**
 * Losslessly strip EXIF and XMP chunks from a WebP RIFF container.
 * Updates the root RIFF file-size header and clears VP8X EXIF/XMP flags when present.
 * @param {ArrayBuffer} inputBuffer
 * @param {{ keepIcc?: boolean }} [options]
 * @returns {StripResult}
 */
export function stripWebpMetadata(inputBuffer, options = {}) {
  const { keepIcc = true } = options;
  const bytes = new Uint8Array(inputBuffer);
  const view = new DataView(inputBuffer);

  if (bytes.byteLength < 12) {
    throw new Error('Invalid WebP stream: file too short.');
  }

  const STRIP_CHUNKS = new Set(['EXIF', 'XMP ']);
  if (!keepIcc) {
    STRIP_CHUNKS.add('ICCP');
  }

  // Reserve 12-byte RIFF + WEBP header (will update size after assembly)
  const header = new Uint8Array(bytes.subarray(0, 12));
  /** @type {Uint8Array[]} */
  const kept = [header];
  /** @type {string[]} */
  const removedSegments = [];
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const fourCC = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    );
    const chunkSize = view.getUint32(offset + 4, true);
    if (offset + 8 + chunkSize > bytes.byteLength) {
      throw new Error(`Truncated WebP chunk: ${fourCC}`);
    }
    const paddedSize = chunkSize + (chunkSize & 1);
    const chunkEnd = Math.min(bytes.byteLength, offset + 8 + paddedSize);

    if (STRIP_CHUNKS.has(fourCC)) {
      removedSegments.push(fourCC.trim());
    } else if (fourCC === 'VP8X' && chunkSize >= 4) {
      // Clone VP8X chunk and clear EXIF (0x08) and XMP (0x04) feature flags
      const vp8xChunk = new Uint8Array(bytes.subarray(offset, chunkEnd));
      vp8xChunk[8] &= ~(0x08 | 0x04);
      if (!keepIcc) {
        vp8xChunk[8] &= ~0x20;
      }
      kept.push(vp8xChunk);
    } else {
      kept.push(bytes.subarray(offset, chunkEnd));
    }

    offset = chunkEnd;
  }

  const outBuffer = concatUint8Arrays(kept);
  const outView = new DataView(outBuffer);
  outView.setUint32(4, outBuffer.byteLength - 8, true);

  return {
    buffer: outBuffer,
    strippedBytes: Math.max(0, inputBuffer.byteLength - outBuffer.byteLength),
    removedSegments,
  };
}

/**
 * Dispatch lossless binary metadata stripping by verified MIME type.
 * @param {ArrayBuffer} inputBuffer
 * @param {string} mime
 * @param {{ keepIcc?: boolean }} [options]
 * @returns {StripResult}
 */
export function stripMetadataBuffer(inputBuffer, mime, options = {}) {
  switch (mime) {
    case 'image/jpeg':
      return stripJpegMetadata(inputBuffer, options);
    case 'image/png':
      return stripPngMetadata(inputBuffer, options);
    case 'image/webp':
      return stripWebpMetadata(inputBuffer, options);
    case 'image/avif':
      throw new Error(
        'Lossless binary strip is supported for JPEG, PNG, and WebP. Switch mode to Compress/Convert to re-encode AVIF without metadata.'
      );
    default:
      throw new Error(`Unsupported format for metadata stripping: ${mime}`);
  }
}

/**
 * Extract raw APP1 segment bytes from a JPEG buffer if present (for optional safe retention).
 * @param {ArrayBuffer} inputBuffer
 * @returns {Uint8Array | null}
 */
export function extractJpegApp1(inputBuffer) {
  const bytes = new Uint8Array(inputBuffer);
  const view = new DataView(inputBuffer);
  if (bytes.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = view.getUint16(offset, false);
    if (marker === 0xffda || marker === 0xffd9) break;
    if (marker === 0xff01 || (marker >= 0xffd0 && marker <= 0xffd7)) {
      offset += 2;
      continue;
    }
    const len = view.getUint16(offset + 2, false);
    if (len < 2 || offset + 2 + len > bytes.byteLength) break;
    if (marker === 0xffe1) {
      // Only return EXIF APP1 (starts with "Exif\0\0")
      if (
        len >= 8 &&
        bytes[offset + 4] === 0x45 &&
        bytes[offset + 5] === 0x78 &&
        bytes[offset + 6] === 0x69 &&
        bytes[offset + 7] === 0x66
      ) {
        return bytes.slice(offset, offset + 2 + len);
      }
    }
    offset += 2 + len;
  }
  return null;
}

/**
 * Inject an APP1 segment immediately after SOI (0xFFD8) in an encoded JPEG buffer.
 * @param {ArrayBuffer} jpegBuffer
 * @param {Uint8Array} app1Segment
 * @returns {ArrayBuffer}
 */
export function injectJpegApp1(jpegBuffer, app1Segment) {
  const bytes = new Uint8Array(jpegBuffer);
  if (bytes.byteLength < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return jpegBuffer;
  }
  return concatUint8Arrays([
    bytes.subarray(0, 2),
    app1Segment,
    bytes.subarray(2),
  ]);
}
