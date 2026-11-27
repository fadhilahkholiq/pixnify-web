/**
 * Pixnify main application entry & worker coordinator.
 * Main thread handles only DOM rendering, user input, and reactive store coordination.
 */

import { store } from './state/store.js';
import { initCompareModal } from './ui/compare-modal.js';
import { initDropzone } from './ui/dropzone.js';
import { initExifDrawer } from './ui/exif-drawer.js';
import { initQueueList } from './ui/queue-list.js';
import { workerPool } from './workers/worker-pool.js';

const EXIF_SLICE_BYTES = 131072; // 128 KB header slice

/**
 * Run 128 KB partial-slice EXIF inspection inside a worker.
 * @param {import('./state/store.js').PixnifyItem} item
 */
async function inspectItemExif(item) {
  try {
    const sliceBuffer = await item.originalFile
      .slice(0, EXIF_SLICE_BYTES)
      .arrayBuffer();
    const { exifData } = await workerPool.inspectExif(sliceBuffer, item.revision);
    if (store.getItem(item.id)) {
      store.updateItem(item.id, { exifData });
    }
  } catch {
    if (store.getItem(item.id)) {
      store.updateItem(item.id, {
        exifData: {
          totalTags: 0,
          riskCounts: { high: 0, medium: 0, safe: 0 },
          highestRisk: 'none',
          hasGps: false,
          coordinates: null,
          entries: [],
        },
      });
    }
  }
}

/**
 * Dispatch an optimization job for a single item using transferable ArrayBuffers.
 * Discards stale results if item revision changed while queued/processing.
 * @param {import('./state/store.js').PixnifyItem} item
 */
async function processQueueItem(item) {
  const revision = item.revision;
  const settingsSnapshot = { ...store.settings };

  store.updateItem(item.id, { status: 'processing', error: null });

  try {
    const fileBuffer = await item.originalFile.arrayBuffer();

    const latest = store.getItem(item.id);
    if (!latest || latest.revision !== revision) {
      return;
    }

    const res = await workerPool.processImage(
      fileBuffer,
      item.detectedMime,
      settingsSnapshot,
      revision
    );

    if (res.cancelled) {
      return;
    }

    const current = store.getItem(item.id);
    if (!current || current.revision !== revision) {
      return;
    }

    const outputMime = res.outputMime || item.detectedMime;
    const outputBlob = new Blob([/** @type {ArrayBuffer} */ (res.outputBuffer)], {
      type: outputMime,
    });
    const outputUrl = URL.createObjectURL(outputBlob);

    try {
      const latestBeforeUpdate = store.getItem(item.id);
      if (!latestBeforeUpdate || latestBeforeUpdate.revision !== revision) {
        URL.revokeObjectURL(outputUrl);
        return;
      }

      store.updateItem(item.id, {
        status: 'done',
        outputBlob,
        outputUrl,
        outputMime,
        outputSize: outputBlob.size,
        originalWidth: res.originalWidth ?? null,
        originalHeight: res.originalHeight ?? null,
        width: res.width ?? null,
        height: res.height ?? null,
        durationMs: res.durationMs ?? null,
        method: res.method ?? null,
        removedSegments: res.removedSegments ?? [],
        error: null,
      });
    } catch (updateErr) {
      URL.revokeObjectURL(outputUrl);
      throw updateErr;
    }
  } catch (err) {
    const current = store.getItem(item.id);
    if (!current || current.revision !== revision) {
      return;
    }

    store.updateItem(item.id, {
      status: 'error',
      error: err instanceof Error ? err.message : 'Failed to process image.',
    });
  }
}

/**
 * Re-dispatch all queued items at the current global revision.
 */
function dispatchAllQueued() {
  for (const item of store.getItems()) {
    if (item.status === 'queued') {
      processQueueItem(item);
    }
  }
}

/**
 * Compute CSS percentage string for sleek range fill track.
 * @param {HTMLInputElement} input
 */
function updateRangeProgress(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const val = Number(input.value) || min;
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--range-progress', `${pct}%`);
}

/**
 * Wire settings controls to the reactive store and worker cancellation.
 */
function initSettingsControls() {
  const modeOptimizeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('mode-optimize-btn'));
  const modeStripBtn = /** @type {HTMLButtonElement} */ (document.getElementById('mode-strip-btn'));
  const modeDescEl = /** @type {HTMLElement} */ (document.getElementById('mode-description'));
  const transcodeFields = /** @type {HTMLElement} */ (document.getElementById('transcode-fields'));
  const formatBtns = Array.from(document.querySelectorAll('#format-grid .format-btn'));
  const qualityInput = /** @type {HTMLInputElement} */ (document.getElementById('setting-quality'));
  const qualityGroup = /** @type {HTMLElement} */ (document.getElementById('quality-field-group'));
  const qualityReadout = /** @type {HTMLElement} */ (document.getElementById('quality-readout'));
  const maxWidthInput = /** @type {HTMLInputElement} */ (document.getElementById('setting-max-width'));
  const maxHeightInput = /** @type {HTMLInputElement} */ (document.getElementById('setting-max-height'));
  const stripMetaCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('setting-strip-metadata'));
  const stripMetaRow = /** @type {HTMLElement} */ (document.getElementById('strip-metadata-row'));
  const keepIccCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('setting-keep-icc'));

  /** @type {number | null} */
  let debounceTimer = null;

  /**
   * @param {Partial<import('./state/store.js').PixnifySettings>} patch
   * @param {boolean} [debounce]
   */
  function applySettings(patch, debounce = false) {
    if (debounceTimer) window.clearTimeout(debounceTimer);

    const run = () => {
      const nextRev = store.updateSettings(patch);
      workerPool.cancelStaleProcessJobs(nextRev);
      dispatchAllQueued();
    };

    if (debounce) {
      debounceTimer = window.setTimeout(run, 160);
    } else {
      run();
    }
  }

  function syncUiState() {
    const { mode, targetFormat, quality } = store.settings;
    const isStrip = mode === 'strip';

    modeOptimizeBtn.classList.toggle('is-active', !isStrip);
    modeOptimizeBtn.setAttribute('aria-pressed', String(!isStrip));
    modeStripBtn.classList.toggle('is-active', isStrip);
    modeStripBtn.setAttribute('aria-pressed', String(isStrip));

    transcodeFields.classList.toggle('is-disabled', isStrip);

    for (const btn of formatBtns) {
      const fmt = btn.getAttribute('data-format');
      const isActive = fmt === targetFormat;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
      /** @type {HTMLButtonElement} */ (btn).disabled = isStrip;
    }

    qualityInput.disabled = isStrip || targetFormat === 'image/png';
    maxWidthInput.disabled = isStrip;
    maxHeightInput.disabled = isStrip;

    qualityGroup.style.opacity = targetFormat === 'image/png' && !isStrip ? '0.45' : '1';
    qualityReadout.textContent =
      targetFormat === 'image/png' ? 'Lossless' : String(quality);
    updateRangeProgress(qualityInput);

    if (isStrip) {
      stripMetaCheckbox.checked = true;
      stripMetaCheckbox.disabled = true;
      stripMetaRow.classList.add('is-locked');
      modeDescEl.textContent =
        'Instant byte-level removal of APP1/EXIF, XMP, and IPTC segments in JPEG, PNG, and WebP with 100% original pixels.';
    } else {
      stripMetaCheckbox.disabled = false;
      stripMetaRow.classList.remove('is-locked');
      modeDescEl.textContent =
        'Decodes pixels, applies optional Lanczos resize, and encodes via MozJPEG, OxiPNG, libwebp, or libavif.';
    }
  }

  modeOptimizeBtn.addEventListener('click', () => {
    if (store.settings.mode === 'optimize') return;
    applySettings({ mode: 'optimize' });
    syncUiState();
  });

  modeStripBtn.addEventListener('click', () => {
    if (store.settings.mode === 'strip') return;
    applySettings({ mode: 'strip', stripMetadata: true });
    syncUiState();
  });

  for (const btn of formatBtns) {
    btn.addEventListener('click', () => {
      const format = /** @type {import('./state/store.js').PixnifySettings['targetFormat']} */ (
        btn.getAttribute('data-format') || 'original'
      );
      if (store.settings.targetFormat === format) return;
      applySettings({ targetFormat: format });
      syncUiState();
    });
  }

  qualityInput.addEventListener('input', () => {
    const val = Number(qualityInput.value);
    qualityReadout.textContent = String(val);
    updateRangeProgress(qualityInput);
    applySettings({ quality: val }, true);
  });

  function onDimensionChange() {
    const maxWidth = Math.max(0, Number.parseInt(maxWidthInput.value, 10) || 0);
    const maxHeight = Math.max(0, Number.parseInt(maxHeightInput.value, 10) || 0);
    applySettings({ maxWidth, maxHeight }, true);
  }

  maxWidthInput.addEventListener('input', onDimensionChange);
  maxHeightInput.addEventListener('input', onDimensionChange);

  stripMetaCheckbox.addEventListener('change', () => {
    applySettings({ stripMetadata: stripMetaCheckbox.checked });
  });

  keepIccCheckbox.addEventListener('change', () => {
    applySettings({ keepIcc: keepIccCheckbox.checked });
  });

  syncUiState();
}

/**
 * Wire lightweight Privacy Info modal triggered from topbar.
 */
function initPrivacyModal() {
  const openBtn = /** @type {HTMLButtonElement} */ (document.getElementById('privacy-info-btn'));
  const modal = /** @type {HTMLElement} */ (document.getElementById('privacy-modal'));
  const closeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('privacy-close-btn'));

  function open() {
    modal.hidden = false;
    openBtn.setAttribute('aria-expanded', 'true');
  }

  function close() {
    modal.hidden = true;
    openBtn.setAttribute('aria-expanded', 'false');
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });
}

/**
 * Display runtime isolation & worker pool capacity badges.
 */
function initRuntimeBadges() {
  const isolationText = document.getElementById('isolation-badge-text');
  const concurrencyLabel = document.getElementById('worker-concurrency-label');
  const poolSize = Math.min(navigator.hardwareConcurrency || 4, 4);

  if (concurrencyLabel) {
    concurrencyLabel.textContent = `${poolSize} Workers`;
  }

  if (isolationText) {
    const isolated = self.crossOriginIsolated === true;
    isolationText.textContent = isolated ? 'WASM Ready' : 'WASM Single-Thread';
  }
}

function bootstrap() {
  initRuntimeBadges();
  initPrivacyModal();
  initSettingsControls();
  initQueueList();
  initExifDrawer();
  initCompareModal();

  initDropzone((acceptedEntries) => {
    const addedItems = store.addFiles(acceptedEntries);
    for (const item of addedItems) {
      inspectItemExif(item);
      processQueueItem(item);
    }
  });

  window.addEventListener('beforeunload', () => {
    store.clearAll();
    workerPool.destroy();
  });
}

bootstrap();
