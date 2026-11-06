/**
 * LRU cache with per-entry TTL.
 * HashMap (key -> node) + doubly linked list (recency order).
 *   get / set / delete : O(1)
 *   eviction           : O(1) — pop the tail
 */
class Node {
  constructor(key, value, expiresAt) {
    this.key = key;
    this.value = value;
    this.expiresAt = expiresAt;
    this.prev = null;
    this.next = null;
  }
}

export class LRUCache {
  constructor({ capacity = 500, ttlMs = 10_000 } = {}) {
    if (capacity < 1) throw new RangeError('capacity must be >= 1');
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.map = new Map();
    this.head = new Node(); // most recent sits after head
    this.tail = new Node(); // least recent sits before tail
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  #unlink(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  #pushFront(node) {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next.prev = node;
    this.head.next = node;
  }

  get(key) {
    const node = this.map.get(key);
    if (!node) { this.misses++; return undefined; }
    if (node.expiresAt <= Date.now()) {
      this.#unlink(node);
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.#unlink(node);
    this.#pushFront(node);
    this.hits++;
    return node.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    const expiresAt = Date.now() + ttlMs;
    let node = this.map.get(key);
    if (node) {
      node.value = value;
      node.expiresAt = expiresAt;
      this.#unlink(node);
      this.#pushFront(node);
      return;
    }
    node = new Node(key, value, expiresAt);
    this.map.set(key, node);
    this.#pushFront(node);
    if (this.map.size > this.capacity) {
      const lru = this.tail.prev;
      this.#unlink(lru);
      this.map.delete(lru.key);
      this.evictions++;
    }
  }

  delete(key) {
    const node = this.map.get(key);
    if (!node) return false;
    this.#unlink(node);
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /** Read-through helper: compute on miss, store, return. */
  async wrap(key, compute, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    this.set(key, value, ttlMs);
    return value;
  }

  get size() { return this.map.size; }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRatio: total ? this.hits / total : 0,
    };
  }
}
