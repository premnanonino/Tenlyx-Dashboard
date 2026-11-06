/**
 * Token-bucket rate limiting.
 * Tokens refill continuously at `refillPerSec` up to `capacity`;
 * each request spends one. Refill is computed lazily on access, so
 * there are no timers per key — O(1) per check.
 */
export class TokenBucketLimiter {
  constructor({ capacity = 60, refillPerSec = 10, idleMs = 10 * 60_000 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.idleMs = idleMs;
    this.buckets = new Map();
    this.allowed = 0;
    this.rejected = 0;
  }

  take(key, cost = 1) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, last: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.last) / 1000) * this.refillPerSec);
    b.last = now;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.allowed++;
      return { ok: true, remaining: Math.floor(b.tokens) };
    }
    this.rejected++;
    return { ok: false, remaining: 0, retryAfterMs: Math.ceil(((cost - b.tokens) / this.refillPerSec) * 1000) };
  }

  /** Drop buckets that have been idle (they would be full anyway). */
  sweep() {
    const cutoff = Date.now() - this.idleMs;
    for (const [k, b] of this.buckets) if (b.last < cutoff) this.buckets.delete(k);
  }

  stats() {
    return { keys: this.buckets.size, allowed: this.allowed, rejected: this.rejected };
  }
}

/**
 * Single shared bucket whose take() *waits* instead of rejecting.
 * Used to pace outbound calls so we stay under Telnyx's API limits.
 */
export class PacedBucket {
  constructor({ ratePerSec = 5, burst = 5 } = {}) {
    this.rate = ratePerSec;
    this.capacity = burst;
    this.tokens = burst;
    this.last = Date.now();
    this.chain = Promise.resolve();
  }

  take() {
    // Serialise waiters so they are served FIFO.
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
        this.last = now;
        if (this.tokens >= 1) { this.tokens -= 1; return; }
        await new Promise((r) => setTimeout(r, Math.ceil(((1 - this.tokens) / this.rate) * 1000)));
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
}
