export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry with exponential backoff and "full jitter":
 *   delay = random(0, min(maxMs, baseMs * 2^attempt))
 * Jitter spreads retries out so many clients don't hammer the API in sync.
 * Honors err.retryAfterMs (from a 429 Retry-After header) when present.
 */
export async function retry(fn, { retries = 3, baseMs = 300, maxMs = 5_000, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || err.retryable === false) throw err;
      const cap = Math.min(maxMs, baseMs * 2 ** attempt);
      const delay = err.retryAfterMs ?? Math.random() * cap;
      onRetry?.({ attempt: attempt + 1, delay, err });
      await sleep(delay);
    }
  }
}
