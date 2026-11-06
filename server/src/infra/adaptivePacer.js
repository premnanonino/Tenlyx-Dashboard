/**
 * Adaptive outbound pacer (AIMD, like TCP congestion control).
 *
 * - Requests are spaced FIFO at `rate` per second.
 * - On a 429 the rate is halved (multiplicative decrease) and every caller
 *   pauses until the upstream's Retry-After (or an exponential cool-down).
 * - After a run of successes the rate creeps back up (additive increase),
 *   capped at `maxRps`. So we settle just under whatever the API allows,
 *   without knowing the limit in advance.
 */
export class AdaptivePacer {
  constructor({ startRps = 1, minRps = 0.1, maxRps = 3, increaseEvery = 20, step = 0.1 } = {}) {
    this.minRps = minRps;
    this.maxRps = Math.max(minRps, maxRps);
    this.rate = Math.min(this.maxRps, Math.max(minRps, startRps));
    this.increaseEvery = increaseEvery;
    this.step = step;
    this.nextAt = 0;          // earliest time the next request may start
    this.pausedUntil = 0;     // global cool-down after a 429
    this.okStreak = 0;
    this.throttleStreak = 0;
    this.throttles = 0;
    this.lastThrottleAt = 0;
    this.chain = Promise.resolve();
    this.waiting = 0;
  }

  /** Resolves when the caller may send its request. */
  take() {
    this.waiting++;
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        const at = Math.max(this.nextAt, this.pausedUntil);
        if (at <= now) break;
        await new Promise((r) => setTimeout(r, at - now));
      }
      this.nextAt = Date.now() + 1000 / this.rate;
      this.waiting--;
    });
    this.chain = next.catch(() => {});
    return next;
  }

  onSuccess() {
    this.throttleStreak = 0;
    if (++this.okStreak >= this.increaseEvery) {
      this.okStreak = 0;
      this.rate = Math.min(this.maxRps, +(this.rate + this.step).toFixed(3));
    }
  }

  /** @param retryAfterMs upstream hint, if any */
  onThrottle(retryAfterMs) {
    this.okStreak = 0;
    this.throttleStreak++;
    this.throttles++;
    this.lastThrottleAt = Date.now();
    this.rate = Math.max(this.minRps, +(this.rate / 2).toFixed(3));
    const backoff = Math.min(60_000, 2_000 * 2 ** (this.throttleStreak - 1));
    const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, 120_000) : backoff;
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + wait);
  }

  /** ms until requests flow again (0 when not cooling down). */
  coolingDownMs(now = Date.now()) {
    return Math.max(0, this.pausedUntil - now);
  }

  stats() {
    return {
      rps: this.rate,
      maxRps: this.maxRps,
      waiting: this.waiting,
      throttles: this.throttles,
      lastThrottleAt: this.lastThrottleAt || null,
      coolingDownMs: this.coolingDownMs(),
    };
  }
}
