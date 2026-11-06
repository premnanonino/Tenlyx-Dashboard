/**
 * Indexed binary min-heap: a heap plus a key -> position map, so the
 * priority of an arbitrary key can be increased in O(log n).
 */
export class IndexedMinHeap {
  constructor() {
    this.keys = [];
    this.pri = [];
    this.pos = new Map();
  }

  get size() { return this.keys.length; }
  has(k) { return this.pos.has(k); }
  priority(k) { const i = this.pos.get(k); return i === undefined ? undefined : this.pri[i]; }
  peek() { return this.keys.length ? [this.keys[0], this.pri[0]] : undefined; }

  #swap(i, j) {
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
    [this.pri[i], this.pri[j]] = [this.pri[j], this.pri[i]];
    this.pos.set(this.keys[i], i);
    this.pos.set(this.keys[j], j);
  }

  #up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.pri[p] <= this.pri[i]) return;
      this.#swap(i, p);
      i = p;
    }
  }

  #down(i) {
    const n = this.keys.length;
    for (;;) {
      const l = 2 * i + 1; const r = l + 1;
      let m = i;
      if (l < n && this.pri[l] < this.pri[m]) m = l;
      if (r < n && this.pri[r] < this.pri[m]) m = r;
      if (m === i) return;
      this.#swap(i, m);
      i = m;
    }
  }

  push(k, p) {
    this.keys.push(k);
    this.pri.push(p);
    this.pos.set(k, this.keys.length - 1);
    this.#up(this.keys.length - 1);
  }

  /** Increase a key's priority; in a min-heap that can only move it down. */
  increase(k, delta) {
    const i = this.pos.get(k);
    this.pri[i] += delta;
    this.#down(i);
  }

  pop() {
    if (!this.keys.length) return undefined;
    const top = [this.keys[0], this.pri[0]];
    this.#swap(0, this.keys.length - 1);
    this.keys.pop(); this.pri.pop();
    this.pos.delete(top[0]);
    if (this.keys.length) this.#down(0);
    return top;
  }
}

/**
 * Weighted Space-Saving heavy-hitters sketch (Metwally et al.).
 * Tracks the top spenders of an unbounded key stream in O(k) memory:
 *  - known key        -> add weight                    O(log k)
 *  - new key, room    -> insert                        O(log k)
 *  - new key, full    -> evict the minimum m, insert the
 *                        new key with weight m + w and error m
 * Every true heavy hitter is guaranteed to be kept, and each reported
 * weight overestimates the truth by at most its `error`.
 */
export class SpaceSaving {
  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.heap = new IndexedMinHeap();
    this.err = new Map();
    this.count = new Map();
  }

  add(key, weight, n = 1) {
    if (this.heap.has(key)) {
      this.heap.increase(key, weight);
      this.count.set(key, this.count.get(key) + n);
      return;
    }
    if (this.heap.size < this.capacity) {
      this.heap.push(key, weight);
      this.err.set(key, 0);
      this.count.set(key, n);
      return;
    }
    const [minKey, minW] = this.heap.pop();
    this.err.delete(minKey);
    this.count.delete(minKey);
    this.heap.push(key, minW + weight);
    this.err.set(key, minW);
    this.count.set(key, n);
  }

  top(n = 10) {
    const all = this.heap.keys.map((k) => ({
      key: k, weight: this.heap.priority(k), error: this.err.get(k), count: this.count.get(k),
    }));
    all.sort((a, b) => b.weight - a.weight);
    return all.slice(0, n);
  }

  toJSON() {
    return { capacity: this.capacity, items: this.heap.keys.map((k) => [k, this.heap.priority(k), this.err.get(k), this.count.get(k)]) };
  }

  static fromJSON(json) {
    const s = new SpaceSaving(json?.capacity ?? 1000);
    for (const [k, w, e, c] of json?.items ?? []) {
      s.heap.push(k, w);
      s.err.set(k, e);
      s.count.set(k, c);
    }
    return s;
  }
}
