/**
 * Binary min-heap on a flat array.
 *   push / pop : O(log n)
 *   peek       : O(1)
 */
export class MinHeap {
  constructor(compare = (a, b) => a - b) {
    this.a = [];
    this.cmp = compare;
  }

  get size() { return this.a.length; }
  peek() { return this.a[0]; }

  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop() {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  /** Replace root and restore heap order — cheaper than pop + push. */
  replaceTop(x) {
    const top = this.a[0];
    this.a[0] = x;
    this.#siftDown(0);
    return top;
  }

  #siftDown(i) {
    const a = this.a;
    const n = a.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.cmp(a[l], a[m]) < 0) m = l;
      if (r < n && this.cmp(a[r], a[m]) < 0) m = r;
      if (m === i) return;
      [a[i], a[m]] = [a[m], a[i]];
      i = m;
    }
  }
}

/**
 * Top-K by score using a size-K min-heap.
 * O(n log k) time, O(k) extra space — beats a full sort when k << n.
 * Returns items sorted by score descending.
 */
export function topK(items, k, score) {
  if (k <= 0) return [];
  const heap = new MinHeap((x, y) => x.s - y.s);
  for (const item of items) {
    const s = score(item);
    if (heap.size < k) heap.push({ s, item });
    else if (s > heap.peek().s) heap.replaceTop({ s, item });
  }
  const out = [];
  while (heap.size) out.push(heap.pop().item);
  return out.reverse();
}
