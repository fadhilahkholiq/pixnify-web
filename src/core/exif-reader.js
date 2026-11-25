/**
 * Partial-slice EXIF / GPS / XMP / IPTC metadata parser & privacy classifier.
 * Designed to run inside a Web Worker on the first 128 KB slice of an image.
 */

import exifr from 'exifr';

export const EXIF_SLICE_BYTES = 131072; // 128 KB

/** @typedef {'high' | 'medium' | 'safe'} PrivacyRiskTier */

/**
 * @typedef {Object} ExifEntry
 * @property {string} key
 * @property {string} value
 * @property {PrivacyRiskTier} tier
 * @property {string} group
 */

/**
 * @typedef {Object} ExifSummary
 * @property {number} totalTags
 * @property {{ high: number, medium: number, safe: number }} riskCounts
 * @property {'high' | 'medium' | 'safe' | 'none'} highestRisk
 * @property {boolean} hasGps
 * @property {{ latitude: number, longitude: number } | null} coordinates
 * @property {ExifEntry[]} entries
 */

const HIGH_RISK_KEYS = new Set([
  'latitude',
  'longitude',
  'GPSLatitude',
  'GPSLongitude',
  'GPSAltitude',
  'GPSAltitudeRef',
  'GPSLatitudeRef',
  'GPSLongitudeRef',
  'GPSDateStamp',
  'GPSTimeStamp',
  'GPSDestLatitude',
  'GPSDestLongitude',
  'GPSProcessingMethod',
  'GPSAreaInformation',
  'SerialNumber',
  'BodySerialNumber',
  'LensSerialNumber',
  'InternalSerialNumber',
  'CameraSerialNumber',
  'Artist',
  'OwnerName',
  'CameraOwnerName',
  'Creator',
  'Byline',
  'Copyright',
  'UserComment',
  'XPAuthor',
  'ImageUniqueID',
]);

const MEDIUM_RISK_KEYS = new Set([
  'DateTimeOriginal',
  'CreateDate',
  'ModifyDate',
  'DateTimeDigitized',
  'DateTime',
  'SubSecTimeOriginal',
  'OffsetTimeOriginal',
  'Software',
  'HostComputer',
  'ProcessingSoftware',
  'CreatorTool',
  'ApplicationRecordVersion',
]);

const SKIP_BINARY_KEYS = new Set([
  'MakerNote',
  'ComponentsConfiguration',
  'FileSource',
  'SceneType',
  'CFAPattern',
]);

/**
 * Classify a tag key into High Privacy Risk, Medium Context, or Technical/Safe.
 * @param {string} key
 * @returns {PrivacyRiskTier}
 */
function classifyTagTier(key) {
  if (HIGH_RISK_KEYS.has(key) || key.startsWith('GPS')) {
    return 'high';
  }
  if (MEDIUM_RISK_KEYS.has(key)) {
    return 'medium';
  }
  return 'safe';
}

/**
 * Format an arbitrary EXIF tag value into a concise display string.
 * @param {unknown} raw
 * @returns {string | null}
 */
function formatTagValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    return `[Binary ${raw.byteLength} B]`;
  }
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  }
  if (Array.isArray(raw)) {
    const preview = raw.slice(0, 6).map((item) => String(item)).join(', ');
    return raw.length > 6 ? `${preview}…` : preview;
  }
  if (typeof raw === 'object') {
    return JSON.stringify(raw).slice(0, 120);
  }
  const str = String(raw).trim();
  return str.length > 140 ? `${str.slice(0, 140)}…` : str;
}

/**
 * Determine human-friendly group label for a tag.
 * @param {string} key
 * @returns {string}
 */
function inferTagGroup(key) {
  if (key === 'latitude' || key === 'longitude' || key.startsWith('GPS')) {
    return 'GPS';
  }
  if (MEDIUM_RISK_KEYS.has(key)) {
    return 'Timestamp & Software';
  }
  if (HIGH_RISK_KEYS.has(key)) {
    return 'Identity & Device';
  }
  return 'Camera & Technical';
}

/**
 * Parse and classify metadata from a 128 KB image header buffer.
 * Never throws on malformed/corrupted metadata.
 * @param {ArrayBuffer | Uint8Array} headerBuffer
 * @returns {Promise<ExifSummary>}
 */
export async function parseExifSummary(headerBuffer) {
  /** @type {ExifSummary} */
  const emptySummary = {
    totalTags: 0,
    riskCounts: { high: 0, medium: 0, safe: 0 },
    highestRisk: 'none',
    hasGps: false,
    coordinates: null,
    entries: [],
  };

  try {
    const parsed = await exifr.parse(new Uint8Array(headerBuffer), {
      tiff: true,
      exif: true,
      gps: true,
      xmp: true,
      iptc: true,
      icc: false,
      jfif: false,
      ihdr: true,
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
      silentErrors: true,
    });

    if (!parsed || typeof parsed !== 'object') {
      return emptySummary;
    }

    /** @type {ExifEntry[]} */
    const entries = [];
    const riskCounts = { high: 0, medium: 0, safe: 0 };

    for (const [key, rawValue] of Object.entries(parsed)) {
      if (SKIP_BINARY_KEYS.has(key)) continue;
      const formatted = formatTagValue(rawValue);
      if (!formatted) continue;

      const tier = classifyTagTier(key);
      riskCounts[tier] += 1;
      entries.push({
        key,
        value: formatted,
        tier,
        group: inferTagGroup(key),
      });
    }

    // Sort High risk first, then Medium, then Safe
    const tierOrder = { high: 0, medium: 1, safe: 2 };
    entries.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || a.key.localeCompare(b.key));

    const hasLatLon =
      typeof parsed.latitude === 'number' &&
      typeof parsed.longitude === 'number' &&
      Number.isFinite(parsed.latitude) &&
      Number.isFinite(parsed.longitude);

    const hasGps = hasLatLon || entries.some((entry) => entry.group === 'GPS');

    let highestRisk = /** @type {'high' | 'medium' | 'safe' | 'none'} */ ('none');
    if (riskCounts.high > 0) highestRisk = 'high';
    else if (riskCounts.medium > 0) highestRisk = 'medium';
    else if (riskCounts.safe > 0) highestRisk = 'safe';

    return {
      totalTags: entries.length,
      riskCounts,
      highestRisk,
      hasGps,
      coordinates: hasLatLon
        ? { latitude: parsed.latitude, longitude: parsed.longitude }
        : null,
      entries,
    };
  } catch {
    return emptySummary;
  }
}
