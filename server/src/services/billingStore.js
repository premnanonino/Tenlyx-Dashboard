import { Trie } from '../dsa/Trie.js';
import { TimeWindowSeries } from '../dsa/SegmentTree.js';
import { RingBuffer } from '../dsa/RingBuffer.js';
import { lowerBound, upperBound } from '../dsa/search.js';
import { topK } from '../dsa/MinHeap.js';

const HOUR = 3_600_000;
const byTs = (r) => r.ts;

/**
 * In-memory, multi-index billing store.
 *
 *   records[]        time-sorted log            -> range slice via binary search, O(log n)
 *   byId (Map)       primary key                -> dedupe on ingest, O(1)
 *   trie             token -> ids               -> prefix search, O(L + k)
 *   total / product  circular segment trees     -> range spend sums, O(log buckets)
 *   balanceHistory   ring buffer of snapshots   -> bounded memory
 *
 * Every mutation bumps `version`; the response cache keys on it, so
 * cached reads are invalidated exactly when the data changes.
 */
export class BillingStore {
  constructor({ retentionMs }) {
    this.retentionMs = retentionMs;
    this.records = [];
    this.byId = new Map();
    this.trie = new Trie();
    const buckets = Math.ceil(retentionMs / HOUR) + 24;
    this.seriesOpts = { bucketMs: HOUR, buckets };
    this.total = new TimeWindowSeries(this.seriesOpts);
    this.byProduct = new Map();
    this.balance = null;
    this.balanceHistory = new RingBuffer(6000);
    this.groups = new Map();
    this.assistants = new Map();
    // Secondary index: AI conversations only, also time-sorted. AI analytics
    // binary-search this instead of scanning the full log.
    this.aiRecords = [];
    this.version = 0;
    this.stats = { ingested: 0, duplicates: 0, outOfOrder: 0, evicted: 0, dropped: 0 };
  }

  #productSeries(product) {
    let s = this.byProduct.get(product);
    if (!s) { s = new TimeWindowSeries(this.seriesOpts); this.byProduct.set(product, s); }
    return s;
  }

  #tokens(r) {
    const g = this.groups.get(r.billingGroupId);
    const groupWords = g ? [g.name, ...g.name.split(/[\s/]+/)] : [];
    const aiWords = r.ai ? [r.ai.model, ...r.ai.model.split(/[/\-.]+/), this.assistantName(r.ai.assistantId), r.ai.outcome] : [];
    return [r.destination, r.country, r.product, r.direction, r.status, r.billingGroupId, ...groupWords, ...aiWords].filter(Boolean);
  }

  groupName(id) {
    return this.groups.get(id)?.name ?? id ?? 'Unassigned';
  }

  setGroups(groups) {
    this.groups = new Map(groups.map((g) => [g.id, g]));
    this.version++;
  }

  setAssistants(list) {
    this.assistants = new Map(list.map((a) => [a.id, a]));
    this.version++;
  }

  assistantName(id) {
    return this.assistants.get(id)?.name ?? id ?? 'Unknown assistant';
  }

  #insertSorted(arr, r) {
    if (!arr.length || r.ts >= arr[arr.length - 1].ts) arr.push(r);
    else arr.splice(upperBound(arr, r.ts, byTs), 0, r);
  }

  setBalance(b) {
    this.balance = b;
    this.balanceHistory.push({ ts: b.ts, balance: b.balance, available: b.availableCredit, pending: b.pending });
    this.version++;
  }

  /** Insert a batch; returns the records that were actually new. */
  ingest(batch, now = Date.now()) {
    if (!batch.length) return [];
    const cutoff = now - this.retentionMs;
    const sorted = [...batch].sort((a, b) => a.ts - b.ts); // O(b log b), makes appends the common path
    const added = [];
    for (const r of sorted) {
      if (this.byId.has(r.id)) { this.stats.duplicates++; continue; }
      if (r.ts < cutoff) { this.stats.dropped++; continue; }

      const recs = this.records;
      if (!recs.length || r.ts >= recs[recs.length - 1].ts) {
        recs.push(r);
      } else {
        // Late arrival: binary-search its slot. O(log n) find + O(n) shift, rare in practice.
        recs.splice(upperBound(recs, r.ts, byTs), 0, r);
        this.stats.outOfOrder++;
      }
      this.byId.set(r.id, r);
      if (r.ai) this.#insertSorted(this.aiRecords, r);
      r._tokens = this.#tokens(r);
      for (const t of r._tokens) this.trie.insert(t, r.id);
      this.total.add(r.ts, r.cost);
      this.#productSeries(r.product).add(r.ts, r.cost);
      added.push(r);
    }
    if (added.length) { this.stats.ingested += added.length; this.version++; }
    return added;
  }

  /** Drop records older than the retention window. */
  evict(now = Date.now()) {
    const idx = lowerBound(this.records, now - this.retentionMs, byTs);
    if (!idx) return 0;
    const removed = this.records.splice(0, idx);
    this.aiRecords.splice(0, lowerBound(this.aiRecords, now - this.retentionMs, byTs));
    for (const r of removed) {
      this.byId.delete(r.id);
      for (const t of r._tokens) this.trie.remove(t, r.id);
    }
    this.stats.evicted += removed.length;
    this.version++;
    return removed.length;
  }

  /** Keep segment-tree heads moving even when traffic is idle. */
  tick(now = Date.now()) {
    this.total.advanceTo(now);
    for (const s of this.byProduct.values()) s.advanceTo(now);
  }

  get products() { return [...this.byProduct.keys()].sort(); }
  get oldestTs() { return this.records[0]?.ts ?? null; }
  get newestTs() { return this.records[this.records.length - 1]?.ts ?? null; }

  /** Binary-search the log for [from, to). */
  sliceBounds(from, to) {
    return { lo: lowerBound(this.records, from, byTs), hi: lowerBound(this.records, to, byTs) };
  }

  /**
   * Filtered record search. Picks between two plans, like a tiny query planner:
   *  - "index": text matched few ids -> fetch those ids, filter by time, sort.
   *  - "scan" : walk the time slice backwards (newest first) and filter.
   * Whichever touches fewer rows wins.
   */
  query({ from, to, q, product, country, direction, limit = 100, before, offset = 0 }) {
    const upper = before ? Math.min(to, before) : to;
    const { lo, hi } = this.sliceBounds(from, upper);
    const sliceSize = hi - lo;

    let candidates = null;
    const words = (q || '').split(/\s+/).map(Trie.normalize).filter(Boolean);
    for (const w of words) {
      const ids = this.trie.searchPrefix(w, 200_000);
      if (candidates === null) candidates = ids;
      else {
        // Intersect by iterating the smaller set: O(min(|a|, |b|)).
        const [small, big] = candidates.size < ids.size ? [candidates, ids] : [ids, candidates];
        candidates = new Set([...small].filter((id) => big.has(id)));
      }
      if (!candidates.size) break;
    }

    const match = (r) =>
      (!product || r.product === product) &&
      (!country || r.country === country) &&
      (!direction || r.direction === direction) &&
      (!candidates || candidates.has(r.id));

    const rows = [];
    let total = 0;
    let sumCost = 0;
    let plan;

    if (candidates && candidates.size < sliceSize) {
      plan = 'index';
      const hits = [];
      for (const id of candidates) {
        const r = this.byId.get(id);
        if (r && r.ts >= from && r.ts < upper && match(r)) hits.push(r);
      }
      hits.sort((a, b) => b.ts - a.ts);
      total = hits.length;
      for (const r of hits) sumCost += r.cost;
      rows.push(...hits.slice(offset, offset + limit));
    } else {
      plan = 'scan';
      for (let i = hi - 1; i >= lo; i--) {
        const r = this.records[i];
        if (!match(r)) continue;
        if (total >= offset && rows.length < limit) rows.push(r);
        total++;
        sumCost += r.cost;
      }
    }

    return {
      plan,
      scanned: plan === 'index' ? candidates.size : sliceSize,
      total,
      sumCost,
      rows: rows.map((r) => this.present(r)),
      offset,
      nextBefore: rows.length === limit ? rows[rows.length - 1].ts : null,
    };
  }

  /**
   * Generator over every record matching the filters, newest first.
   * Lets the CSV export stream an arbitrarily large result with O(1)
   * extra memory instead of materialising it.
   */
  *scan({ from, to, q, product, country, direction }) {
    const { lo, hi } = this.sliceBounds(from, to);
    let candidates = null;
    for (const w of (q || '').split(/\s+/).map(Trie.normalize).filter(Boolean)) {
      const ids = this.trie.searchPrefix(w, 1_000_000);
      candidates = candidates === null ? ids : new Set([...ids].filter((id) => candidates.has(id)));
    }
    for (let i = hi - 1; i >= lo; i--) {
      const r = this.records[i];
      if (product && r.product !== product) continue;
      if (country && r.country !== country) continue;
      if (direction && r.direction !== direction) continue;
      if (candidates && !candidates.has(r.id)) continue;
      yield r;
    }
  }

  /** Top-K aggregation over a time range with a size-K min-heap. */
  top(by, k, from, to) {
    const keyFn = {
      destination: (r) => r.destination,
      country: (r) => r.country,
      billingGroup: (r) => r.billingGroupId ?? 'unassigned',
      product: (r) => r.product,
    }[by];
    if (!keyFn) throw Object.assign(new Error(`unknown dimension "${by}"`), { status: 400 });

    const { lo, hi } = this.sliceBounds(from, to);
    const agg = new Map(); // hash aggregation, O(n)
    let grand = 0;
    for (let i = lo; i < hi; i++) {
      const r = this.records[i];
      // Number rental and AI conversations carry no phone number; keep them out of the
      // "numbers" list (same rule as the monthly report's top numbers).
      if (by === 'destination' && (r.product === 'numbers' || r.ai?.channel === 'chat' || !r.destination)) continue;
      const key = keyFn(r);
      let a = agg.get(key);
      if (!a) { a = { key, cost: 0, count: 0, units: 0 }; agg.set(key, a); }
      a.cost += r.cost;
      a.count++;
      a.units += r.units;
      grand += r.cost;
    }
    return {
      distinct: agg.size,
      total: grand,
      items: topK(agg.values(), k, (a) => a.cost).map((a) => ({
        ...a,
        label: by === 'billingGroup' ? this.groupName(a.key === 'unassigned' ? null : a.key) : a.key,
        share: grand ? a.cost / grand : 0,
      })),
    };
  }

  suggest(prefix, limit) {
    return this.trie.suggest(prefix, limit);
  }

  present(r) {
    const { _tokens, ...rest } = r;
    return { ...rest, billingGroup: this.groupName(r.billingGroupId) };
  }
}
