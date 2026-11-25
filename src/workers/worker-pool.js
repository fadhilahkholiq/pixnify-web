/**
 * Bounded Web Worker Pool & batch ZIP coordinator.
 * Caps codec workers at min(hardwareConcurrency || 4, 4) to prevent OOM
 * on high-megapixel batches and supports revision-based stale job cancellation.
 */

const POOL_SIZE = Math.min(
  typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4,
  4
);

/**
 * @typedef {Object} QueuedJob
 * @property {string} jobId
 * @property {'inspect' | 'process'} type
 * @property {number} revision
 * @property {Object} payload
 * @property {Transferable[]} transfer
 * @property {(result: any) => void} resolve
 * @property {(error: Error) => void} reject
 */

class WorkerPool {
  constructor() {
    /** @type {Array<{ worker: Worker, busy: boolean, currentJob: QueuedJob | null }>} */
    this.slots = [];
    /** @type {QueuedJob[]} */
    this.queue = [];
    /** @type {number} */
    this.jobSeq = 0;
    /** @type {number} */
    this.activeRevision = 1;
    /** @type {Worker | null} */
    this.zipWorker = null;
  }

  /**
   * Spawn a codec worker slot lazily up to POOL_SIZE.
   */
  ensureSlot() {
    const idle = this.slots.find((slot) => !slot.busy);
    if (idle) return idle;

    if (this.slots.length >= POOL_SIZE) {
      return null;
    }

    const worker = new Worker(
      new URL('./codec.worker.js', import.meta.url),
      { type: 'module' }
    );

    const slot = { worker, busy: false, currentJob: null };

    worker.addEventListener('message', (event) => {
      const data = event.data;
      const job = slot.currentJob;
      slot.currentJob = null;
      slot.busy = false;

      if (job) {
        // Discard stale process responses if settings changed mid-flight
        if (job.type === 'process' && job.revision < this.activeRevision) {
          job.resolve({ cancelled: true });
        } else if (data && data.ok) {
          job.resolve(data.result);
        } else {
          const msg = data?.error?.message || 'Worker task failed.';
          job.reject(new Error(msg));
        }
      }

      this.drainQueue();
    });

    worker.addEventListener('error', (event) => {
      const job = slot.currentJob;
      slot.currentJob = null;
      slot.busy = false;

      if (job) {
        job.reject(new Error(event.message || 'Uncaught codec worker error.'));
      }

      this.drainQueue();
    });

    this.slots.push(slot);
    return slot;
  }

  /**
   * Dispatch queued jobs to idle worker slots.
   */
  drainQueue() {
    while (this.queue.length > 0) {
      const slot = this.ensureSlot();
      if (!slot) break;

      const nextJob = this.queue.shift();
      if (!nextJob) break;

      if (nextJob.type === 'process' && nextJob.revision < this.activeRevision) {
        nextJob.resolve({ cancelled: true });
        continue;
      }

      slot.busy = true;
      slot.currentJob = nextJob;
      slot.worker.postMessage(nextJob.payload, nextJob.transfer);
    }
  }

  /**
   * Cancel all unstarted queued process jobs older than newRevision,
   * and mark in-flight older process jobs to be discarded upon return.
   * @param {number} newRevision
   */
  cancelStaleProcessJobs(newRevision) {
    this.activeRevision = newRevision;
    const retained = [];

    for (const job of this.queue) {
      if (job.type === 'process' && job.revision < newRevision) {
        job.resolve({ cancelled: true });
      } else {
        retained.push(job);
      }
    }

    this.queue = retained;
  }

  /**
   * Enqueue a 128 KB partial-slice EXIF inspection job.
   * @param {ArrayBuffer} sliceBuffer
   * @param {number} revision
   * @returns {Promise<{ exifData: import('../core/exif-reader.js').ExifSummary }>}
   */
  inspectExif(sliceBuffer, revision) {
    const jobId = `inspect-${++this.jobSeq}`;
    return new Promise((resolve, reject) => {
      this.queue.push({
        jobId,
        type: 'inspect',
        revision,
        payload: {
          type: 'inspect',
          jobId,
          revision,
          buffer: sliceBuffer,
        },
        transfer: [sliceBuffer],
        resolve,
        reject,
      });
      this.drainQueue();
    });
  }

  /**
   * Enqueue an image optimization job (Path A lossless strip or Path B Wasm).
   * Transfers the source ArrayBuffer with zero-copy semantics.
   * @param {ArrayBuffer} fileBuffer
   * @param {string} mime
   * @param {import('../state/store.js').PixnifySettings} settings
   * @param {number} revision
   * @returns {Promise<{
   *   cancelled?: boolean,
   *   outputBuffer?: ArrayBuffer,
   *   outputMime?: string,
   *   originalWidth?: number | null,
   *   originalHeight?: number | null,
   *   width?: number | null,
   *   height?: number | null,
   *   method?: string,
   *   removedSegments?: string[],
   *   durationMs?: number
   * }>}
   */
  processImage(fileBuffer, mime, settings, revision) {
    const jobId = `process-${++this.jobSeq}`;
    return new Promise((resolve, reject) => {
      this.queue.push({
        jobId,
        type: 'process',
        revision,
        payload: {
          type: 'process',
          jobId,
          revision,
          buffer: fileBuffer,
          mime,
          settings: { ...settings },
        },
        transfer: [fileBuffer],
        resolve,
        reject,
      });
      this.drainQueue();
    });
  }

  /**
   * Build a ZIP archive off the main thread using fflate in zip.worker.js.
   * Transfers every entry's ArrayBuffer cleanly.
   * @param {Array<{ name: string, buffer: ArrayBuffer }>} entries
   * @returns {Promise<ArrayBuffer>}
   */
  createZipArchive(entries) {
    if (!this.zipWorker) {
      this.zipWorker = new Worker(
        new URL('./zip.worker.js', import.meta.url),
        { type: 'module' }
      );
    }

    const jobId = `zip-${++this.jobSeq}`;
    const transfer = entries.map((entry) => entry.buffer);

    return new Promise((resolve, reject) => {
      const worker = /** @type {Worker} */ (this.zipWorker);

      const onMessage = (event) => {
        const data = event.data;
        if (!data || data.jobId !== jobId) return;
        cleanup();
        if (data.ok) {
          resolve(data.result.zipBuffer);
        } else {
          reject(new Error(data?.error?.message || 'ZIP packaging failed.'));
        }
      };

      const onError = (event) => {
        cleanup();
        reject(new Error(event.message || 'ZIP worker error.'));
      };

      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ jobId, entries }, transfer);
    });
  }

  /**
   * Terminate all workers cleanly (e.g. on page unload if needed).
   */
  destroy() {
    for (const slot of this.slots) {
      slot.worker.terminate();
    }
    this.slots = [];
    this.queue = [];
    if (this.zipWorker) {
      this.zipWorker.terminate();
      this.zipWorker = null;
    }
  }
}

export const workerPool = new WorkerPool();
