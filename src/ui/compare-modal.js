/**
 * Split-slider visual quality comparison modal (Original vs Optimized).
 */

import { formatMimeLabel } from '../core/file-sniffer.js';
import { store } from '../state/store.js';
import { formatBytes } from './queue-list.js';

export function initCompareModal() {
  const modal = /** @type {HTMLElement} */ (document.getElementById('compare-modal'));
  const closeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('compare-close-btn'));
  const titleEl = /** @type {HTMLElement} */ (document.getElementById('compare-modal-title'));
  const metaEl = /** @type {HTMLElement} */ (document.getElementById('compare-modal-meta'));
  const stage = /** @type {HTMLElement} */ (document.getElementById('compare-stage'));
  const overlay = /** @type {HTMLElement} */ (document.getElementById('compare-overlay'));
  const divider = /** @type {HTMLElement} */ (document.getElementById('compare-divider'));
  const origImg = /** @type {HTMLImageElement} */ (document.getElementById('compare-img-original'));
  const optImg = /** @type {HTMLImageElement} */ (document.getElementById('compare-img-optimized'));
  const origBadge = /** @type {HTMLElement} */ (document.getElementById('compare-label-original'));
  const optBadge = /** @type {HTMLElement} */ (document.getElementById('compare-label-optimized'));
  const rangeInput = /** @type {HTMLInputElement} */ (document.getElementById('compare-range'));
  const percentEl = /** @type {HTMLElement} */ (document.getElementById('compare-percent'));

  let isDragging = false;

  /**
   * @param {number} pct
   */
  function setSplit(pct) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    overlay.style.clipPath = `inset(0 ${100 - clamped}% 0 0)`;
    divider.style.left = `${clamped}%`;
    rangeInput.value = String(clamped);
    percentEl.textContent = `${clamped}%`;
  }

  function closeModal() {
    if (store.activeCompareItemId !== null) {
      store.setActiveCompareItem(null);
    }
  }

  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) {
      closeModal();
    }
  });

  rangeInput.addEventListener('input', () => {
    setSplit(Number(rangeInput.value));
  });

  /**
   * @param {PointerEvent} event
   */
  function updateFromPointer(event) {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((event.clientX - rect.left) / rect.width) * 100;
    setSplit(pct);
  }

  stage.addEventListener('pointerdown', (event) => {
    isDragging = true;
    stage.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  });

  stage.addEventListener('pointermove', (event) => {
    if (!isDragging) return;
    updateFromPointer(event);
  });

  stage.addEventListener('pointerup', (event) => {
    isDragging = false;
    if (stage.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
  });

  function render() {
    const itemId = store.activeCompareItemId;
    const item = itemId ? store.getItem(itemId) : null;

    if (!item || !item.outputUrl) {
      modal.hidden = true;
      origImg.removeAttribute('src');
      optImg.removeAttribute('src');
      return;
    }

    modal.hidden = false;
    titleEl.textContent = item.originalFile.name;

    const origLabel = formatMimeLabel(item.detectedMime);
    const outLabel = formatMimeLabel(item.outputMime || item.detectedMime);
    const outSize = item.outputSize ?? item.originalFile.size;
    const dims = item.width && item.height ? ` · ${item.width}×${item.height}` : '';

    metaEl.textContent = `${origLabel} (${formatBytes(item.originalFile.size)}) → ${outLabel} (${formatBytes(outSize)})${dims}`;
    origBadge.textContent = `Original · ${formatBytes(item.originalFile.size)}`;
    optBadge.textContent = `Optimized · ${formatBytes(outSize)}`;

    origImg.src = item.originalUrl;
    optImg.src = item.outputUrl;
    setSplit(50);
  }

  store.subscribe(() => render());
}
