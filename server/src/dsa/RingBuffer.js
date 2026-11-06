/**
 * Fixed-capacity circular buffer. Oldest entries are overwritten.
 *   push : O(1)    memory : O(capacity), never grows
 */
export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buf = new Array(capacity);
    this.start = 0;
    this.length = 0;
  }

  push(x) {
    const end = (this.start + this.length) % this.capacity;
    this.buf[end] = x;
    if (this.length < this.capacity) this.length++;
    else this.start = (this.start + 1) % this.capacity;
  }

  at(i) {
    if (i < 0) i += this.length;
    if (i < 0 || i >= this.length) return undefined;
    return this.buf[(this.start + i) % this.capacity];
  }

  last() { return this.at(-1); }

  toArray() {
    const out = new Array(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.buf[(this.start + i) % this.capacity];
    return out;
  }

  /** Last n items, oldest first. */
  tail(n) {
    const k = Math.min(n, this.length);
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = this.at(this.length - k + i);
    return out;
  }

  clear() { this.start = 0; this.length = 0; }
}

/** Percentile over numeric samples (nearest-rank). O(n log n). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
