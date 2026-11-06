// Client for the analysis worker (src/analysis/worker.js), with cancellation.

export class AnalysisWorker {
  constructor() {
    this.spawn();
  }

  spawn() {
    this.worker = new Worker(new URL("../analysis/worker.js", import.meta.url), { type: "module", name: "aadl-analysis" });
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      if (data.progress !== undefined) return p.onProgress?.(data.progress);
      this.pending.delete(data.id);
      if (data.error) {
        const err = new Error(data.error);
        err.stack = data.stack;
        p.reject(err);
      } else p.resolve(data);
    };
  }

  /** Run a built-in analysis; resolves to { result, elapsed }. */
  run(request, { onProgress } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, ...request });
    });
  }

  /** Stop whatever is running (the worker is replaced). */
  cancel() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("Cancelled"));
    this.spawn();
  }
}
