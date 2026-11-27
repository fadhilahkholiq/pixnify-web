/**
 * Dropzone, native file picker, stage-wide drag-and-drop, and clipboard paste (Ctrl/Cmd+V).
 * Validates every file via magic-byte sniffing before entering the store.
 */

import { sniffFileMime } from '../core/file-sniffer.js';

/**
 * Initialize file ingestion UI across empty dropzone, active stage, and header/batch buttons.
 * @param {(entries: Array<{ file: File, mime: import('../core/file-sniffer.js').SupportedMime }>) => void} onFilesAccepted
 */
export function initDropzone(onFilesAccepted) {
  const stage = /** @type {HTMLElement} */ (document.getElementById('workspace-stage'));
  const dropzone = /** @type {HTMLElement} */ (document.getElementById('dropzone'));
  const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file-input'));
  const browseBtn = /** @type {HTMLButtonElement} */ (document.getElementById('browse-files-btn'));
  const headerAddBtn = /** @type {HTMLButtonElement} */ (document.getElementById('header-add-btn'));
  const batchAddMoreBtn = /** @type {HTMLButtonElement} */ (document.getElementById('batch-add-more-btn'));
  const noticeEl = /** @type {HTMLElement} */ (document.getElementById('dropzone-notice'));

  /** @type {number | null} */
  let noticeTimer = null;
  let dragDepth = 0;

  /**
   * @param {string} message
   */
  function showNotice(message) {
    noticeEl.textContent = message;
    noticeEl.hidden = false;
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      noticeEl.hidden = true;
    }, 4500);
  }

  /**
   * Sniff magic bytes of incoming files and forward supported images.
   * @param {FileList | File[]} rawFiles
   */
  async function handleIncomingFiles(rawFiles) {
    const files = Array.from(rawFiles);
    if (files.length === 0) return;

    /** @type {Array<{ file: File, mime: import('../core/file-sniffer.js').SupportedMime }>} */
    const accepted = [];
    /** @type {string[]} */
    const rejectedNames = [];

    await Promise.all(
      files.map(async (file) => {
        try {
          const mime = await sniffFileMime(file);
          if (mime) {
            accepted.push({ file, mime });
          } else {
            rejectedNames.push(file.name || 'clipboard-image');
          }
        } catch {
          rejectedNames.push(file.name || 'unknown');
        }
      })
    );

    if (accepted.length > 0) {
      onFilesAccepted(accepted);
    }

    if (rejectedNames.length > 0) {
      showNotice(
        `Skipped ${rejectedNames.length} unsupported file${rejectedNames.length > 1 ? 's' : ''} (only valid JPEG, PNG, WebP, and AVIF magic bytes are accepted).`
      );
    }
  }

  function openPicker() {
    fileInput.value = '';
    fileInput.click();
  }

  browseBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openPicker();
  });

  headerAddBtn.addEventListener('click', openPicker);
  batchAddMoreBtn.addEventListener('click', openPicker);

  dropzone.addEventListener('click', openPicker);
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files) {
      handleIncomingFiles(fileInput.files);
    }
  });

  // Support dropping files on the entire right stage (both empty and active queue states)
  stage.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    stage.classList.add('is-dragover');
    dropzone.classList.add('is-dragover');
  });

  stage.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

  stage.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      stage.classList.remove('is-dragover');
      dropzone.classList.remove('is-dragover');
    }
  });

  stage.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    stage.classList.remove('is-dragover');
    dropzone.classList.remove('is-dragover');
    if (event.dataTransfer?.files) {
      handleIncomingFiles(event.dataTransfer.files);
    }
  });

  // Prevent browser from navigating when files are dropped outside the stage
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  // Clipboard paste support (Ctrl/Cmd+V)
  document.addEventListener('paste', (event) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    /** @type {File[]} */
    const pastedFiles = [];
    for (const entry of items) {
      if (entry.kind === 'file') {
        const file = entry.getAsFile();
        if (file) {
          const namedFile =
            file.name && file.name !== 'image.png'
              ? file
              : new File([file], `pasted-${Date.now()}.png`, { type: file.type });
          pastedFiles.push(namedFile);
        }
      }
    }

    if (pastedFiles.length > 0) {
      handleIncomingFiles(pastedFiles);
    }
  });
}
