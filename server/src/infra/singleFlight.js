/**
 * Request coalescing ("single flight").
 * Concurrent callers asking for the same key share one in-flight promise,
 * so a burst of identical requests results in exactly one upstream call.
 */
export class SingleFlight {
  constructor() {
    this.inflight = new Map();
    this.executed = 0;
    this.shared = 0;
  }

  do(key, fn) {
    const existing = this.inflight.get(key);
    if (existing) { this.shared++; return existing; }
    this.executed++;
    const p = Promise.resolve()
      .then(fn)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  stats() {
    return { inflight: this.inflight.size, executed: this.executed, shared: this.shared };
  }
}
