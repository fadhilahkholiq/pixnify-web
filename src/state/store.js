/**
 * Reactive state store for Pixnify.
 * Holds lightweight item metadata, File handles, and output Blob references.
 * Never retains uncompressed ImageData or raw ArrayBuffers in global state.
 */

/**
 * @typedef {'queued' | 'processing' | 'done' | 'error'} ItemStatus
 */

/**
 * @typedef {Object} PixnifySettings
 * @property {'optimize' | 'strip'} mode
 * @property {'original' | 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif'} targetFormat
 * @property {number} quality
 * @property {number} maxWidth
 * @property {number} maxHeight
 * @property {boolean} stripMetadata
 * @property {boolean} keepIcc
 */

/**
 * @typedef {Object} PixnifyItem
 * @property {string} id
 * @property {number} revision
 * @property {File} originalFile
 * @property {string} originalUrl
 * @property {import('../core/file-sniffer.js').SupportedMime} detectedMime
 * @property {import('../core/exif-reader.js').ExifSummary | null} exifData
 * @property {ItemStatus} status
 * @property {Blob | null} outputBlob
 * @property {string | null} outputUrl
 * @property {string | null} outputMime
 * @property {number | null} outputSize
 * @property {number | null} originalWidth
 * @property {number | null} originalHeight
 * @property {number | null} width
 * @property {number | null} height
 * @property {number | null} durationMs
 * @property {string | null} method
 * @property {string[]} removedSegments
 * @property {string | null} error
 */

/** @type {PixnifySettings} */
const DEFAULT_SETTINGS = {
  mode: 'optimize',
  targetFormat: 'original',
  quality: 82,
  maxWidth: 0,
  maxHeight: 0,
  stripMetadata: true,
  keepIcc: true,
};

class PixnifyStore extends EventTarget {
  constructor() {
    super();
    /** @type {PixnifySettings} */
    this.settings = { ...DEFAULT_SETTINGS };
    /** @type {Map<string, PixnifyItem>} */
    this.items = new Map();
    /** @type {string[]} */
    this.order = [];
    /** @type {number} */
    this.globalRevision = 1;
    /** @type {string | null} */
    this.activeExifItemId = null;
    /** @type {string | null} */
    this.activeCompareItemId = null;
  }

  /**
   * Subscribe to store change events.
   * @param {(detail: { type: string, itemId?: string }) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    const handler = (event) => listener(/** @type {CustomEvent} */ (event).detail);
    this.addEventListener('change', handler);
    return () => this.removeEventListener('change', handler);
  }

  /**
   * @param {string} type
   * @param {string} [itemId]
   */
  emit(type, itemId) {
    this.dispatchEvent(new CustomEvent('change', { detail: { type, itemId } }));
  }

  /**
   * @returns {PixnifyItem[]}
   */
  getItems() {
    return this.order
      .map((id) => this.items.get(id))
      .filter((item) => Boolean(item));
  }

  /**
   * @param {string} id
   * @returns {PixnifyItem | undefined}
   */
  getItem(id) {
    return this.items.get(id);
  }

  /**
   * Add validated files into the queue.
   * @param {Array<{ file: File, mime: import('../core/file-sniffer.js').SupportedMime }>} entries
   * @returns {PixnifyItem[]}
   */
  addFiles(entries) {
    /** @type {PixnifyItem[]} */
    const added = [];

    for (const { file, mime } of entries) {
      const id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      /** @type {PixnifyItem} */
      const item = {
        id,
        revision: this.globalRevision,
        originalFile: file,
        originalUrl: URL.createObjectURL(file),
        detectedMime: mime,
        exifData: null,
        status: 'queued',
        outputBlob: null,
        outputUrl: null,
        outputMime: null,
        outputSize: null,
        originalWidth: null,
        originalHeight: null,
        width: null,
        height: null,
        durationMs: null,
        method: null,
        removedSegments: [],
        error: null,
      };

      this.items.set(id, item);
      this.order.push(id);
      added.push(item);
    }

    if (added.length > 0) {
      this.emit('items-added');
    }
    return added;
  }

  /**
   * Update fields on a single item, revoking replaced outputUrl when applicable.
   * @param {string} id
   * @param {Partial<PixnifyItem>} patch
   */
  updateItem(id, patch) {
    const existing = this.items.get(id);
    if (!existing) return;

    if (
      Object.prototype.hasOwnProperty.call(patch, 'outputUrl') &&
      existing.outputUrl &&
      existing.outputUrl !== patch.outputUrl
    ) {
      URL.revokeObjectURL(existing.outputUrl);
    }

    this.items.set(id, { ...existing, ...patch });
    this.emit('item-updated', id);
  }

  /**
   * Remove an item and revoke all its ObjectURLs.
   * @param {string} id
   */
  removeItem(id) {
    const item = this.items.get(id);
    if (!item) return;

    if (item.originalUrl) {
      URL.revokeObjectURL(item.originalUrl);
    }
    if (item.outputUrl) {
      URL.revokeObjectURL(item.outputUrl);
    }

    this.items.delete(id);
    this.order = this.order.filter((entryId) => entryId !== id);

    if (this.activeExifItemId === id) {
      this.activeExifItemId = null;
    }
    if (this.activeCompareItemId === id) {
      this.activeCompareItemId = null;
    }

    this.emit('item-removed', id);
  }

  /**
   * Clear all items and revoke every ObjectURL.
   */
  clearAll() {
    for (const item of this.items.values()) {
      if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
      if (item.outputUrl) URL.revokeObjectURL(item.outputUrl);
    }
    this.items.clear();
    this.order = [];
    this.activeExifItemId = null;
    this.activeCompareItemId = null;
    this.emit('cleared');
  }

  /**
   * Mutate settings, bump revision token, and mark existing items queued for re-processing.
   * @param {Partial<PixnifySettings>} patch
   * @returns {number} New global revision
   */
  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.globalRevision += 1;

    for (const id of this.order) {
      const item = this.items.get(id);
      if (!item) continue;
      if (item.outputUrl) {
        URL.revokeObjectURL(item.outputUrl);
      }
      this.items.set(id, {
        ...item,
        revision: this.globalRevision,
        status: 'queued',
        outputBlob: null,
        outputUrl: null,
        outputSize: null,
        durationMs: null,
        error: null,
      });
    }

    this.emit('settings-updated');
    return this.globalRevision;
  }

  /**
   * @param {string | null} itemId
   */
  setActiveExifItem(itemId) {
    this.activeExifItemId = itemId;
    this.emit('modal-changed', itemId || undefined);
  }

  /**
   * @param {string | null} itemId
   */
  setActiveCompareItem(itemId) {
    this.activeCompareItemId = itemId;
    this.emit('modal-changed', itemId || undefined);
  }

  /**
   * Compute aggregate queue statistics.
   */
  getStats() {
    let total = 0;
    let queued = 0;
    let processing = 0;
    let done = 0;
    let error = 0;
    let originalBytes = 0;
    let optimizedBytes = 0;
    let completedOriginalBytes = 0;
    let highRiskCount = 0;

    for (const id of this.order) {
      const item = this.items.get(id);
      if (!item) continue;
      total += 1;
      originalBytes += item.originalFile.size;
      if (item.exifData?.highestRisk === 'high') {
        highRiskCount += 1;
      }

      if (item.status === 'queued') queued += 1;
      else if (item.status === 'processing') processing += 1;
      else if (item.status === 'error') error += 1;
      else if (item.status === 'done') {
        done += 1;
        completedOriginalBytes += item.originalFile.size;
        optimizedBytes += item.outputSize ?? item.originalFile.size;
      }
    }

    const savedBytes = Math.max(0, completedOriginalBytes - optimizedBytes);
    const savedPercent =
      completedOriginalBytes > 0
        ? Math.round((savedBytes / completedOriginalBytes) * 100)
        : 0;

    return {
      total,
      queued,
      processing,
      done,
      error,
      originalBytes,
      optimizedBytes,
      completedOriginalBytes,
      savedBytes,
      savedPercent,
      highRiskCount,
    };
  }
}

export const store = new PixnifyStore();
