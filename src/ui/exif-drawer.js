/**
 * Interactive EXIF / GPS Privacy Inspector drawer with 3-tier filtering.
 */

import { store } from '../state/store.js';

export function initExifDrawer() {
  const backdrop = /** @type {HTMLElement} */ (document.getElementById('exif-backdrop'));
  const drawer = /** @type {HTMLElement} */ (document.getElementById('exif-drawer'));
  const closeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('exif-close-btn'));
  const subtitleEl = /** @type {HTMLElement} */ (document.getElementById('exif-drawer-subtitle'));
  const gpsAlertEl = /** @type {HTMLElement} */ (document.getElementById('exif-gps-alert'));
  const bodyEl = /** @type {HTMLElement} */ (document.getElementById('exif-drawer-body'));
  const filterBtns = Array.from(document.querySelectorAll('.drawer-filters .filter-pill'));

  /** @type {'all' | 'high' | 'medium' | 'safe'} */
  let activeTier = 'all';

  function closeDrawer() {
    if (store.activeExifItemId !== null) {
      store.setActiveExifItem(null);
    }
  }

  closeBtn.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) {
      closeDrawer();
    }
  });

  for (const btn of filterBtns) {
    btn.addEventListener('click', () => {
      const tier = /** @type {'all' | 'high' | 'medium' | 'safe'} */ (
        btn.getAttribute('data-tier') || 'all'
      );
      activeTier = tier;
      for (const peer of filterBtns) {
        peer.classList.toggle('is-active', peer === btn);
      }
      render();
    });
  }

  function render() {
    const itemId = store.activeExifItemId;
    const item = itemId ? store.getItem(itemId) : null;

    if (!item) {
      backdrop.hidden = true;
      drawer.hidden = true;
      return;
    }

    backdrop.hidden = false;
    drawer.hidden = false;
    subtitleEl.textContent = item.originalFile.name;

    const exif = item.exifData;
    if (!exif) {
      gpsAlertEl.hidden = true;
      bodyEl.innerHTML = '<div class="empty-state">Scanning header metadata…</div>';
      return;
    }

    if (exif.hasGps) {
      gpsAlertEl.hidden = false;
      gpsAlertEl.textContent = exif.coordinates
        ? `Embedded GPS coordinates detected (${exif.coordinates.latitude.toFixed(5)}, ${exif.coordinates.longitude.toFixed(5)}). Pixnify strips these tags locally before export.`
        : 'Embedded GPS location tags detected. Pixnify strips these tags locally before export.';
    } else {
      gpsAlertEl.hidden = true;
    }

    const filtered =
      activeTier === 'all'
        ? exif.entries
        : exif.entries.filter((entry) => entry.tier === activeTier);

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent =
        exif.totalTags === 0
          ? 'No EXIF, GPS, XMP, or IPTC metadata found in this file.'
          : 'No tags match this privacy filter.';
      bodyEl.replaceChildren(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const entry of filtered) {
      const row = document.createElement('div');
      row.className = 'exif-row';

      const top = document.createElement('div');
      top.className = 'exif-row-top';

      const keyEl = document.createElement('span');
      keyEl.className = 'exif-key';
      keyEl.textContent = entry.key;

      const tierTag = document.createElement('span');
      tierTag.className = entry.tier === 'high' ? 'tag tag-ink' : 'tag';
      tierTag.textContent =
        entry.tier === 'high'
          ? 'High Risk'
          : entry.tier === 'medium'
          ? 'Medium'
          : 'Technical';

      const valEl = document.createElement('span');
      valEl.className = 'exif-val';
      valEl.textContent = entry.value;

      top.append(keyEl, tierTag);
      row.append(top, valEl);
      frag.appendChild(row);
    }

    bodyEl.replaceChildren(frag);
  }

  store.subscribe(() => render());
}
