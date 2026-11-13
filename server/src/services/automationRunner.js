import { validateResult } from './automation.js';

/**
 * Executes queued Call Automation runs in the worker (the only role that may
 * place calls or run long jobs). One scheduler tick:
 *
 *   1. expire   running past its deadline → timeout; queued for too long → error
 *   2. reap     abort local executions whose run was cancelled or timed out
 *   3. claim    start queued runs up to `concurrency`
 *
 * Executors are plug-ins keyed by case type (API, PHONE, HYBRID):
 *
 *   executor(run, { signal, logger }) → Promise<{ status: 'passed'|'failed'|'error',
 *       assertions?, error?, telnyxCallControlId?, courserevCallId?, artifacts? }>
 *
 * They must stop work when `signal` aborts. A type without an executor ends
 * its runs with a clear error instead of leaving them queued.
 *
 * Every run is bounded twice: the executor is aborted at the deadline, and the
 * database marks the run `timeout` even if the executor never returns.
 */
export class AutomationRunner {
  constructor({ repo, executors = {}, logger, concurrency = 1, queueTimeoutMs = 60 * 60_000 }) {
    Object.assign(this, { repo, executors, logger, concurrency, queueTimeoutMs });
    this.active = new Map(); // run id → { controller, timer, done }
    this.stats = { started: 0, passed: 0, failed: 0, errors: 0, timedOut: 0, cancelled: 0, lastRunAt: null, lastError: null };
  }

  /** Worker start: runs left `running` by a previous worker can never finish. */
  async recover(now = Date.now()) {
    const ids = await this.repo.abandonRunning(now);
    if (ids.length) this.logger?.warn('automation runs abandoned by a previous worker', { ids });
    return ids;
  }

  async tick(now = Date.now()) {
    const { timedOut } = await this.repo.expireRuns({ now, queuedBefore: now - this.queueTimeoutMs });
    this.stats.timedOut += timedOut.length;

    if (this.active.size) {
      const statuses = await this.repo.runStatuses([...this.active.keys()]);
      for (const [id, a] of this.active) {
        const s = statuses.get(id);
        if (s !== 'running') {
          if (s === 'cancelled') this.stats.cancelled++;
          a.controller.abort(new Error(`run ${s ?? 'deleted'}`));
        }
      }
    }

    let started = 0;
    while (this.active.size < this.concurrency) {
      const run = await this.repo.claimNextRun(Date.now());
      if (!run) break;
      this.#launch(run);
      started++;
    }
    return started;
  }

  #launch(run) {
    const controller = new AbortController();
    const wait = Math.max(0, (run.deadlineAt ?? Date.now()) - Date.now());
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('run exceeded its timeout'), { timeout: true })), wait);
    timer.unref?.();
    const entry = { controller, timer, done: null };
    this.active.set(run.id, entry);
    this.stats.started++;
    this.stats.lastRunAt = Date.now();
    entry.done = this.#execute(run, controller.signal)
      .catch((err) => { this.stats.lastError = err.message; this.logger?.error('automation run could not be stored', { run: run.id, err: err.message }); })
      .finally(() => { clearTimeout(timer); this.active.delete(run.id); });
  }

  async #execute(run, signal) {
    const type = run.case?.type;
    const executor = this.executors[type];
    const log = this.logger?.child?.(`run:${run.id}`) ?? this.logger;
    let result;
    if (!executor) {
      result = { status: 'error', error: `no executor is available for ${type} tests yet` };
    } else {
      try {
        result = validateResult(await executor(run, { signal, logger: log }));
      } catch (err) {
        result = signal.aborted
          ? { status: signal.reason?.timeout ? 'timeout' : 'error', error: String(signal.reason?.message ?? 'aborted') }
          : { status: 'error', error: err.message };
      }
    }
    const stored = await this.repo.finishRun(run.id, validateResult(result, { allow: ['passed', 'failed', 'error', 'timeout'] }));
    if (stored) {
      if (result.status === 'passed') this.stats.passed++;
      else if (result.status === 'failed') this.stats.failed++;
      else if (result.status === 'timeout') this.stats.timedOut++;
      else this.stats.errors++;
      log?.info('automation run finished', { run: run.id, case: run.caseId, status: result.status });
    }
    return stored;
  }

  /** Abort everything in flight and wait (bounded) for executors to settle. */
  async stop(graceMs = 5_000) {
    for (const a of this.active.values()) a.controller.abort(new Error('worker shutting down'));
    const all = Promise.allSettled([...this.active.values()].map((a) => a.done));
    await Promise.race([all, new Promise((r) => setTimeout(r, graceMs).unref?.())]);
  }

  /** In-flight work, for the worker status document. */
  progress() {
    return { active: [...this.active.keys()], concurrency: this.concurrency, executors: Object.keys(this.executors), ...this.stats };
  }

  /** Test helper: wait for the current executions to finish. */
  async idle() {
    await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }
}
