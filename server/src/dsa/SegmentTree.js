/**
 * Iterative (bottom-up) segment tree for range sums.
 *   point add / set : O(log n)
 *   range query     : O(log n)   over half-open [l, r)
 */
export class SegmentTree {
  constructor(n) {
    this.n = n;
    this.t = new Float64Array(2 * n);
  }

  add(i, delta) {
    let p = i + this.n;
    this.t[p] += delta;
    for (p >>= 1; p >= 1; p >>= 1) this.t[p] = this.t[2 * p] + this.t[2 * p + 1];
  }

  set(i, value) { this.add(i, value - this.t[i + this.n]); }
  get(i) { return this.t[i + this.n]; }

  query(l, r) {
    let s = 0;
    for (l += this.n, r += this.n; l < r; l >>= 1, r >>= 1) {
      if (l & 1) s += this.t[l++];
      if (r & 1) s += this.t[--r];
    }
    return s;
  }
}

/**
 * Sliding time window of fixed-width buckets stored in a circular
 * segment tree. Answers "how much was spent between t1 and t2" in
 * O(log n) regardless of how many records fall in the range.
 *
 * Bucket b lives in slot (b mod N). When the head advances, slots that
 * are about to be reused are zeroed first, so the tree only ever holds
 * the most recent N buckets.
 */
export class TimeWindowSeries {
  constructor({ bucketMs = 3_600_000, buckets = 840 } = {}) {
    this.bucketMs = bucketMs;
    this.N = buckets;
    this.sums = new SegmentTree(buckets);
    this.counts = new SegmentTree(buckets);
    this.slotBucket = new Float64Array(buckets).fill(-1);
    this.head = -Infinity; // newest bucket index seen
  }

  #slot(b) { return ((b % this.N) + this.N) % this.N; }

  advanceTo(ts) {
    const b = Math.floor(ts / this.bucketMs);
    if (b <= this.head) return;
    const from = this.head === -Infinity ? b - this.N + 1 : Math.max(this.head + 1, b - this.N + 1);
    for (let x = from; x <= b; x++) {
      const s = this.#slot(x);
      if (this.slotBucket[s] !== x) {
        this.sums.set(s, 0);
        this.counts.set(s, 0);
        this.slotBucket[s] = x;
      }
    }
    this.head = b;
  }

  /** Returns false when ts is older than the window (record dropped). */
  add(ts, amount, count = 1) {
    this.advanceTo(ts);
    const b = Math.floor(ts / this.bucketMs);
    if (b <= this.head - this.N) return false;
    const s = this.#slot(b);
    if (this.slotBucket[s] !== b) return false;
    this.sums.add(s, amount);
    this.counts.add(s, count);
    return true;
  }

  #rangeQuery(tree, fromTs, toTs) {
    let bFrom = Math.floor(fromTs / this.bucketMs);
    let bTo = Math.ceil(toTs / this.bucketMs); // exclusive
    bFrom = Math.max(bFrom, this.head - this.N + 1);
    bTo = Math.min(bTo, this.head + 1);
    if (bFrom >= bTo) return 0;
    const len = bTo - bFrom;
    const s = this.#slot(bFrom);
    // Range may wrap past the end of the circular array: split in two.
    if (s + len <= this.N) return tree.query(s, s + len);
    return tree.query(s, this.N) + tree.query(0, len - (this.N - s));
  }

  /** Sum of amounts in [fromTs, toTs), at bucket granularity. */
  sum(fromTs, toTs) {
    const v = this.#rangeQuery(this.sums, fromTs, toTs);
    return Math.abs(v) < 1e-9 ? 0 : v;
  }

  count(fromTs, toTs) { return Math.round(this.#rangeQuery(this.counts, fromTs, toTs)); }

  /** Per-bucket values between from and to (aligned to bucketMs). */
  buckets(fromTs, toTs) {
    const out = [];
    const start = Math.floor(fromTs / this.bucketMs) * this.bucketMs;
    for (let t = start; t < toTs; t += this.bucketMs) out.push({ t, v: this.sum(t, t + this.bucketMs) });
    return out;
  }
}
