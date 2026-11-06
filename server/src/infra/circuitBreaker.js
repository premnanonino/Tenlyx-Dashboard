import { RingBuffer } from '../dsa/RingBuffer.js';

export class BreakerOpenError extends Error {
  constructor(name, retryInMs) {
    super(`circuit "${name}" is open`);
    this.code = 'BREAKER_OPEN';
    this.retryable = false;
    this.retryInMs = retryInMs;
  }
}

/**
 * Circuit breaker: CLOSED -> OPEN -> HALF_OPEN -> CLOSED.
 *
 * CLOSED     calls pass; outcomes go into a sliding window. When the window
 *            has >= minCalls and failure rate >= threshold, trip to OPEN.
 * OPEN       calls fail fast for `cooldownMs` (protects Telnyx and us).
 * HALF_OPEN  one probe call is allowed; success closes, failure re-opens.
 */
export class CircuitBreaker {
  constructor({ name, windowSize = 20, minCalls = 5, failureRate = 0.5, cooldownMs = 30_000, onChange } = {}) {
    this.name = name;
    this.window = new RingBuffer(windowSize);
    this.minCalls = minCalls;
    this.failureRate = failureRate;
    this.cooldownMs = cooldownMs;
    this.onChange = onChange;
    this.state = 'CLOSED';
    this.openedAt = 0;
    this.probing = false;
    this.trips = 0;
    this.shortCircuited = 0;
  }

  #transition(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    if (next === 'OPEN') { this.openedAt = Date.now(); this.trips++; }
    if (next === 'CLOSED') this.window.clear();
    this.onChange?.({ name: this.name, from: prev, to: next });
  }

  #failureRatio() {
    const xs = this.window.toArray();
    if (xs.length < this.minCalls) return 0;
    return xs.filter((ok) => !ok).length / xs.length;
  }

  async exec(fn) {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        this.shortCircuited++;
        throw new BreakerOpenError(this.name, this.cooldownMs - elapsed);
      }
      this.#transition('HALF_OPEN');
    }
    if (this.state === 'HALF_OPEN') {
      if (this.probing) { this.shortCircuited++; throw new BreakerOpenError(this.name, 1000); }
      this.probing = true;
      try {
        const result = await fn();
        this.#transition('CLOSED');
        return result;
      } catch (err) {
        this.#transition('OPEN');
        throw err;
      } finally {
        this.probing = false;
      }
    }
    try {
      const result = await fn();
      this.window.push(true);
      return result;
    } catch (err) {
      // Client errors (4xx other than 429) are our fault, not the dependency's.
      if (err.countsAsFailure !== false) this.window.push(false);
      if (this.#failureRatio() >= this.failureRate) this.#transition('OPEN');
      throw err;
    }
  }

  stats() {
    return {
      name: this.name,
      state: this.state,
      failureRatio: this.#failureRatio(),
      windowSize: this.window.length,
      trips: this.trips,
      shortCircuited: this.shortCircuited,
      reopensInMs: this.state === 'OPEN' ? Math.max(0, this.cooldownMs - (Date.now() - this.openedAt)) : 0,
    };
  }
}
