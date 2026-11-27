/**
 * Queue list, sticky batch summary bar, emerald savings pills, risk badges,
 * single download & off-thread ZIP export.
 */

import { formatMimeLabel, mimeToExtension } from '../core/file-sniffer.js';
import { store } from '../state/store.js';
import { workerPool } from '../workers/worker-pool.js';

/**
 * Format byte size cleanly (B, KB, MB).
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Build safe download filename using the optimized MIME extension.
 * @param {string} originalName
 * @param {string} outputMime
 * @returns {string}
 */
function buildOutputFilename(originalName, outputMime) {
  const ext = mimeToExtension(outputMime);
  const dotIdx = originalName.lastIndexOf('.');
  const base = dotIdx > 0 ? originalName.slice(0, dotIdx) : originalName;
  return `${base}.${ext}`;
}

/**
 * Trigger a browser download from an existing URL.
 * @param {string} url
 * @param {string} filename
 */
function triggerDownloadUrl(url, filename) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Build EXIF privacy badge button for an item using restrained semantic accents.
 * @param {import('../state/store.js').PixnifyItem} item
 * @returns {HTMLButtonElement}
 */
function createExifBadge(item) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'risk-pill';

  if (!item.exifData) {
    btn.classList.add('risk-safe');
    btn.textContent = 'Scanning EXIF…';
    btn.disabled = true;
    return btn;
  }

  const { highestRisk, riskCounts, hasGps, totalTags } = item.exifData;
  if (highestRisk === 'high') {
    btn.classList.add('risk-high');
    btn.textContent = hasGps
      ? `GPS & ${riskCounts.high} High Risk`
      : `${riskCounts.high} High Risk`;
  } else if (highestRisk === 'medium') {
    btn.classList.add('risk-medium');
    btn.textContent = `${riskCounts.medium} Context Tags`;
  } else if (highestRisk === 'safe') {
    btn.classList.add('risk-safe');
    btn.textContent = `${totalTags} Tech Tags`;
  } else {
    btn.classList.add('risk-safe');
    btn.textContent = 'No EXIF';
  }

  btn.title = 'Inspect extracted metadata';
  btn.addEventListener('click', () => {
    store.setActiveExifItem(item.id);
  });

  return btn;
}

/**
 * Create a DOM card element for a single PixnifyItem.
 * @param {import('../state/store.js').PixnifyItem} item
 * @returns {HTMLElement}
 */
function renderQueueCard(item) {
  const card = document.createElement('article');
  card.className = 'queue-card';
  card.dataset.itemId = item.id;

  // Thumbnail
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'queue-thumb-wrap';
  const thumb = document.createElement('img');
  thumb.className = 'queue-thumb';
  thumb.loading = 'lazy';
  thumb.alt = item.originalFile.name;
  thumb.src = item.outputUrl || item.originalUrl;
  thumbWrap.appendChild(thumb);

  // Info column
  const info = document.createElement('div');
  info.className = 'queue-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'queue-title-row';

  const filenameEl = document.createElement('span');
  filenameEl.className = 'queue-filename';
  filenameEl.textContent = item.originalFile.name;

  const formatTag = document.createElement('span');
  formatTag.className = 'mono-pill';
  const inLabel = formatMimeLabel(item.detectedMime);
  const outLabel = item.outputMime ? formatMimeLabel(item.outputMime) : null;
  formatTag.textContent =
    outLabel && outLabel !== inLabel ? `${inLabel} → ${outLabel}` : inLabel;

  titleRow.append(filenameEl, formatTag, createExifBadge(item));

  const metaRow = document.createElement('div');
  metaRow.className = 'queue-meta-row';

  if (item.status === 'queued') {
    metaRow.textContent = `${formatBytes(item.originalFile.size)} · Queued`;
  } else if (item.status === 'processing') {
    metaRow.textContent = `${formatBytes(item.originalFile.size)} · Optimizing…`;
  } else if (item.status === 'error') {
    metaRow.textContent = `${formatBytes(item.originalFile.size)} · Failed`;
  } else if (item.status === 'done') {
    const outSize = item.outputSize ?? item.originalFile.size;
    const diff = item.originalFile.size - outSize;
    const pct =
      item.originalFile.size > 0
        ? Math.round((diff / item.originalFile.size) * 100)
        : 0;

    const sizeText = document.createElement('span');
    sizeText.textContent = `${formatBytes(item.originalFile.size)} → ${formatBytes(outSize)}`;

    const savingsBadge = document.createElement('span');
    if (pct > 0) {
      savingsBadge.className = 'emerald-pill';
      savingsBadge.textContent = `-${pct}% (${formatBytes(diff)})`;
    } else if (pct === 0) {
      savingsBadge.className = 'mono-pill';
      savingsBadge.textContent = '0% (Lossless)';
    } else {
      savingsBadge.className = 'mono-pill';
      savingsBadge.textContent = `+${Math.abs(pct)}%`;
    }

    metaRow.append(sizeText, savingsBadge);

    if (item.width && item.height) {
      const dimSpan = document.createElement('span');
      dimSpan.textContent = `${item.width}×${item.height}`;
      metaRow.appendChild(dimSpan);
    }

    if (item.method === 'lossless-strip') {
      const stripSpan = document.createElement('span');
      const segCount = item.removedSegments.length;
      stripSpan.textContent =
        segCount > 0
          ? `Stripped ${item.removedSegments.join(', ')} · ${item.durationMs} ms`
          : `Clean · ${item.durationMs} ms`;
      metaRow.appendChild(stripSpan);
    } else if (item.durationMs) {
      const timeSpan = document.createElement('span');
      timeSpan.textContent = `${item.durationMs} ms`;
      metaRow.appendChild(timeSpan);
    }
  }

  info.append(titleRow, metaRow);

  if (item.status === 'error' && item.error) {
    const errEl = document.createElement('p');
    errEl.className = 'queue-error';
    errEl.textContent = item.error;
    info.appendChild(errEl);
  }

  // Actions column
  const actions = document.createElement('div');
  actions.className = 'queue-actions';

  if (item.status === 'done' && item.outputUrl) {
    const compareBtn = document.createElement('button');
    compareBtn.type = 'button';
    compareBtn.className = 'btn btn-secondary btn-compact';
    compareBtn.textContent = 'Compare';
    compareBtn.addEventListener('click', () => {
      store.setActiveCompareItem(item.id);
    });

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'icon-btn';
    downloadBtn.setAttribute('aria-label', `Download ${item.originalFile.name}`);
    downloadBtn.title = 'Download optimized file';
    downloadBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2.5V10.5M8 10.5L4.75 7.25M8 10.5L11.25 7.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 12.5V13C2.5 13.5523 2.94772 14 3.5 14H12.5C13.0523 14 13.5 13.5523 13.5 13V12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    downloadBtn.addEventListener('click', () => {
      const outName = buildOutputFilename(
        item.originalFile.name,
        item.outputMime || item.detectedMime
      );
      triggerDownloadUrl(/** @type {string} */ (item.outputUrl), outName);
    });

    actions.append(compareBtn, downloadBtn);
  }

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'icon-btn';
  removeBtn.setAttribute('aria-label', `Remove ${item.originalFile.name}`);
  removeBtn.title = 'Remove';
  removeBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  removeBtn.addEventListener('click', () => {
    store.removeItem(item.id);
  });

  actions.appendChild(removeBtn);
  card.append(thumbWrap, info, actions);
  return card;
}

/**
 * Initialize queue UI rendering, empty/active stage toggle, and ZIP export.
 */
export function initQueueList() {
  const dropzoneWrap = /** @type {HTMLElement} */ (document.getElementById('dropzone-wrap'));
  const queueWorkspace = /** @type {HTMLElement} */ (document.getElementById('queue-workspace'));
  const headerAddBtn = /** @type {HTMLButtonElement} */ (document.getElementById('header-add-btn'));
  const queueListEl = /** @type {HTMLElement} */ (document.getElementById('queue-list'));
  const statProgressEl = /** @type {HTMLElement} */ (document.getElementById('stat-progress'));
  const statSavedEl = /** @type {HTMLElement} */ (document.getElementById('stat-saved'));
  const statRisksWrap = /** @type {HTMLElement} */ (document.getElementById('stat-risks-wrap'));
  const statRisksEl = /** @type {HTMLElement} */ (document.getElementById('stat-risks'));
  const progressFillEl = /** @type {HTMLElement} */ (document.getElementById('batch-progress-fill'));
  const clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById('clear-queue-btn'));
  const downloadZipBtn = /** @type {HTMLButtonElement} */ (document.getElementById('download-zip-btn'));

  let isZipping = false;

  clearBtn.addEventListener('click', () => {
    store.clearAll();
  });

  downloadZipBtn.addEventListener('click', async () => {
    if (isZipping) return;
    const completed = store
      .getItems()
      .filter((item) => item.status === 'done' && item.outputBlob);

    if (completed.length === 0) return;

    isZipping = true;
    downloadZipBtn.disabled = true;
    downloadZipBtn.textContent = 'Bundling ZIP…';

    try {
      const entries = await Promise.all(
        completed.map(async (item) => ({
          name: buildOutputFilename(
            item.originalFile.name,
            item.outputMime || item.detectedMime
          ),
          buffer: await /** @type {Blob} */ (item.outputBlob).arrayBuffer(),
        }))
      );

      const zipBuffer = await workerPool.createZipArchive(entries);
      const zipBlob = new Blob([zipBuffer], { type: 'application/zip' });
      const zipUrl = URL.createObjectURL(zipBlob);
      try {
        triggerDownloadUrl(zipUrl, `pixnify-batch-${Date.now()}.zip`);
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(zipUrl), 10000);
      }
    } finally {
      isZipping = false;
      render();
    }
  });

  function render() {
    const items = store.getItems();
    const stats = store.getStats();
    const hasItems = items.length > 0;

    dropzoneWrap.hidden = hasItems;
    queueWorkspace.hidden = !hasItems;
    headerAddBtn.hidden = !hasItems;

    if (!hasItems) {
      queueListEl.replaceChildren();
      return;
    }

    const completedTotal = stats.done + stats.error;
    const pctDone = stats.total > 0 ? Math.round((completedTotal / stats.total) * 100) : 0;

    statProgressEl.textContent = `${completedTotal}/${stats.total}`;
    statSavedEl.textContent = `${formatBytes(stats.savedBytes)} (${stats.savedPercent}%)`;

    if (stats.highRiskCount > 0) {
      statRisksWrap.hidden = false;
      statRisksEl.textContent = `${stats.highRiskCount} file${stats.highRiskCount === 1 ? '' : 's'}`;
    } else {
      statRisksWrap.hidden = true;
    }

    progressFillEl.style.width = `${pctDone}%`;

    if (!isZipping) {
      downloadZipBtn.textContent =
        stats.done > 0 ? `Download All (${stats.done}) .zip` : 'Download All (.zip)';
      downloadZipBtn.disabled = stats.done === 0;
    }

    const fragment = document.createDocumentFragment();
    for (const item of items) {
      fragment.appendChild(renderQueueCard(item));
    }
    queueListEl.replaceChildren(fragment);
  }

  store.subscribe(({ type }) => {
    if (type !== 'modal-changed') {
      render();
    }
  });

  render();
}
