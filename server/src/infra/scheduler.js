import { RingBuffer, percentile } from '../dsa/RingBuffer.js';

/**
 * Job scheduler for polling work.
 * - setTimeout chaining (not setInterval) so a slow run never overlaps itself
 * - +/- jitter so jobs don't align and burst the upstream API
 * - exponential backoff on consecutive failures, reset on success
 * - latency samples kept in a ring buffer for p50 / p95
 */
export class Scheduler {
  constructor({ logger } = {}) {
    this.logger = logger;
    this.jobs = new Map();
    this.running = false;
  }

  add({ name, everyMs, run, jitter = 0.1, maxBackoffMs = 10 * 60_000 }) {
    this.jobs.set(name, {
      name, everyMs, run, jitter, maxBackoffMs,
      timer: null, runs: 0, failures: 0, consecutiveFailures: 0,
      lastRunAt: 0, lastOkAt: 0, lastError: null, nextRunAt: 0,
      durations: new RingBuffer(120),
    });
    return this;
  }

  /** Bootstrap already ran each job once, so the first tick waits a full interval. */
  start() {
    this.running = true;
    for (const job of this.jobs.values()) this.#schedule(job, job.everyMs);
  }

  stop() {
    this.running = false;
    for (const job of this.jobs.values()) clearTimeout(job.timer);
  }

  /** Run a job now (e.g. manual refresh). Shares nothing with the timer chain. */
  async trigger(name) {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`unknown job ${name}`);
    return job.run();
  }

  #schedule(job, delay) {
    if (!this.running) return;
    job.nextRunAt = Date.now() + delay;
    job.timer = setTimeout(() => this.#tick(job), delay);
    job.timer.unref?.();
  }

  async #tick(job) {
    if (!this.running) return;
    const t0 = performance.now();
    job.lastRunAt = Date.now();
    job.runs++;
    try {
      await job.run();
      job.consecutiveFailures = 0;
      job.lastOkAt = Date.now();
      job.lastError = null;
    } catch (err) {
      job.failures++;
      job.consecutiveFailures++;
      job.lastError = err.message;
      this.logger?.warn('job failed', { job: job.name, err: err.message, streak: job.consecutiveFailures });
    } finally {
      job.durations.push(performance.now() - t0);
      const base = job.consecutiveFailures
        ? Math.min(job.everyMs * 2 ** job.consecutiveFailures, job.maxBackoffMs)
        : job.everyMs;
      const delay = base * (1 + (Math.random() * 2 - 1) * job.jitter);
      this.#schedule(job, delay);
    }
  }

  stats() {
    return [...this.jobs.values()].map((j) => {
      const d = j.durations.toArray();
      return {
        name: j.name,
        everyMs: j.everyMs,
        runs: j.runs,
        failures: j.failures,
        consecutiveFailures: j.consecutiveFailures,
        lastRunAt: j.lastRunAt,
        lastOkAt: j.lastOkAt,
        nextRunAt: j.nextRunAt,
        lastError: j.lastError,
        p50Ms: Math.round(percentile(d, 50)),
        p95Ms: Math.round(percentile(d, 95)),
      };
    });
  }
}
