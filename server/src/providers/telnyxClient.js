import { normalizeBalance, normalizeTelnyxRecord } from './normalize.js';
import { sleep } from '../infra/retry.js';

/**
 * Thin HTTP client for the Telnyx v2 REST API.
 * Responsibilities: auth, adaptive pacing, per-request retry, timeouts,
 * error classification, pagination and normalisation.
 *
 * Records are exposed as an async generator of pages, so callers can
 * ingest batch by batch: a throttle or failure mid-way never throws away
 * what was already fetched, and the dashboard fills in progressively.
 */
export class TelnyxClient {
  constructor({ config, pacer, logger }) {
    this.cfg = config.telnyx;
    this.pacer = pacer;
    this.logger = logger;
    this.kind = 'telnyx';
    this.unsupported = new Set();
    // Observability counters (reported by the worker's status document).
    this.metrics = { requests: 0, ok: 0, retries: 0, throttled: 0, serverErrors: 0, failures: 0, lastOkAt: null, lastError: null };
  }

  /** One HTTP GET with its own retry: 429 waits on the shared pacer, 5xx/network back off. */
  async #get(path, query = {}) {
    const url = new URL(this.cfg.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      await this.pacer.take();
      this.metrics.requests++;
      if (attempt > 0) this.metrics.retries++;
      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch (e) {
        if (attempt < MAX_ATTEMPTS) { await sleep(backoff(attempt)); continue; }
        throw Object.assign(new Error(`network error on ${path}: ${e.message}`), { retryable: true });
      }

      if (res.ok) {
        this.pacer.onSuccess();
        this.metrics.ok++;
        this.metrics.lastOkAt = Date.now();
        return res.json();
      }

      const body = await res.text().catch(() => '');
      if (res.status === 429) {
        this.metrics.throttled++;
        // Rate limited: slow everyone down and wait as long as Telnyx asks.
        this.pacer.onThrottle(retryAfterMs(res.headers));
        this.logger?.warn('telnyx rate limited, slowing down', { path, rps: this.pacer.rate, pauseMs: this.pacer.coolingDownMs() });
        if (attempt < MAX_THROTTLED_ATTEMPTS) continue;
      } else if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        this.metrics.serverErrors++;
        await sleep(backoff(attempt));
        continue;
      }

      const err = new Error(`telnyx ${res.status} on ${path}: ${body.slice(0, 200)}`);
      err.status = res.status;
      err.throttled = res.status === 429;
      err.retryable = res.status === 429 || res.status >= 500;
      // Being throttled is our pacing, and 401/404 are configuration:
      // neither means Telnyx is unhealthy, so neither trips the breaker.
      err.countsAsFailure = res.status >= 500;
      this.metrics.failures++;
      this.metrics.lastError = { at: Date.now(), status: res.status, path };
      throw err;
    }
  }

  async #paginate(path, query) {
    const out = [];
    for await (const { rows } of this.#pages(path, query)) out.push(...rows);
    return out;
  }

  /**
   * Yield { rows, page } until meta.total_pages. Telnyx silently caps
   * page[size] (50 on /detail_records), so short pages are NOT the end.
   * `firstBody` is the already-fetched response for `startPage`.
   */
  async* #pages(path, query, firstBody = null, startPage = 1) {
    for (let page = startPage; page <= this.cfg.maxPages; page++) {
      const body = page === startPage && firstBody
        ? firstBody
        : await this.#get(path, { ...query, 'page[number]': page, 'page[size]': this.cfg.pageSize });
      const rows = Array.isArray(body.data) ? body.data : [];
      if (rows.length) yield { rows, page };
      const totalPages = body.meta?.total_pages ?? body.meta?.page_count ?? 1;
      if (page >= totalPages || rows.length === 0) return;
      if (page === this.cfg.maxPages) this.logger?.warn('page cap reached, results truncated', { path, totalPages });
    }
  }

  async getBalance() {
    const body = await this.#get('/balance');
    return normalizeBalance(body.data || {});
  }

  async listBillingGroups() {
    const rows = await this.#paginate('/billing_groups', {});
    return rows.map((g) => ({ id: g.id, name: g.name || g.id, createdAt: Date.parse(g.created_at) || null }));
  }

  /** GET /v2/ai/assistants — names and configured models for AI stats. */
  async listAssistants() {
    const body = await this.#get('/ai/assistants');
    const rows = Array.isArray(body.data) ? body.data : [];
    return rows.map((a) => ({ id: a.id, name: a.name || a.id, model: a.model || null }));
  }

  get recordTypes() {
    return [...new Set([...this.cfg.recordTypes, ...this.cfg.aiRecordTypes.filter((t) => !this.unsupported.has(t))])];
  }

  /**
   * Billed records in [since, until), as an async stream of normalised
   * batches (one per upstream page). Every type is walked oldest-first.
   *
   * Each batch carries `batch.pos` = { type, a, b, page }: the page just
   * read. Passing a saved pos back as `resume` continues with the next
   * page, so pages that were already stored are not downloaded again.
   */
  async* recordBatches({ since, until, resume = null }) {
    const types = this.recordTypes;
    const startIdx = resume ? Math.max(0, types.indexOf(resume.type)) : 0;
    for (let i = startIdx; i < types.length; i++) {
      const type = types[i];
      const from = resume && i === startIdx && resume.type === type ? resume : null;
      try {
        for await (const { rows, a, b, page } of this.#typePages(type, since, until, from)) {
          const batch = [];
          for (const raw of rows) {
            const rec = normalizeTelnyxRecord(raw, type);
            if (rec) batch.push(rec);
          }
          batch.pos = { type, a, b, page };
          yield batch; // yielded even when empty, so the position still advances
        }
      } catch (err) {
        // An AI record type the account/API doesn't support must not block billing data.
        if (this.cfg.aiRecordTypes.includes(type) && err.status >= 400 && err.status < 500 && err.status !== 429) {
          this.unsupported.add(type);
          this.logger?.warn('AI record type unsupported, skipping', { type, status: err.status });
          continue;
        }
        throw err;
      }
    }
  }

  /** Convenience: the whole range in one array (used by tests and small ranges). */
  async listDetailRecords({ since, until }) {
    const out = [];
    for await (const batch of this.recordBatches({ since, until })) out.push(...batch);
    return out;
  }

  /**
   * One record type over [since, until). The time field differs per type
   * (call legs only accept started_at), and a single query is capped at
   * ~10k results upstream, so windows are split until each fits.
   */
  async* #typePages(type, since, until, resume = null) {
    const field = TIME_FIELD[type] || 'created_at';
    const stack = [];
    for (let t = since; t < until; t += WINDOW_MS) stack.push([t, Math.min(t + WINDOW_MS, until)]);
    stack.reverse();
    while (stack.length) {
      const [a, b] = stack.pop();
      // Resuming: windows that ended before the checkpoint are done; the
      // checkpoint's own window continues after its last stored page.
      if (resume && b <= resume.a) continue;
      const startPage = resume && a === resume.a && b === resume.b ? resume.page + 1 : 1;
      const query = {
        'filter[record_type]': type,
        [`filter[${field}][gte]`]: new Date(a).toISOString(),
        [`filter[${field}][lt]`]: new Date(b).toISOString(),
        sort: field,
      };
      const first = await this.#get('/detail_records', { ...query, 'page[number]': startPage, 'page[size]': this.cfg.pageSize });
      const total = first.meta?.total_results ?? 0;
      const fits = total < UPSTREAM_RESULT_CAP && Math.ceil(total / this.cfg.pageSize) <= this.cfg.maxPages;
      if (startPage === 1 && !fits && b - a > MIN_WINDOW_MS) {
        const mid = a + Math.floor((b - a) / 2);
        stack.push([mid, b], [a, mid]); // process the earlier half first
        continue;
      }
      for await (const { rows, page } of this.#pages('/detail_records', query, first, startPage)) yield { rows, a, b, page };
    }
  }
}

const MAX_ATTEMPTS = 3;            // 5xx / network
const MAX_THROTTLED_ATTEMPTS = 6;  // 429s, each after the pacer's cool-down
const backoff = (attempt) => Math.random() * Math.min(8_000, 500 * 2 ** attempt);

/** Retry-After (seconds or HTTP date), or an x-ratelimit-reset hint. */
function retryAfterMs(headers) {
  const ra = headers.get('retry-after');
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s)) return s * 1000;
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return at - Date.now();
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    // Either epoch seconds or seconds-from-now, depending on the API.
    return reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000;
  }
  return undefined;
}

// Call legs reject filter[created_at] ("Field 'created_at' is not valid for record_type 'call-control'").
const TIME_FIELD = {
  'call-control': 'started_at',
  'sip-trunking': 'started_at',
  conference: 'started_at',
  'conference-participant': 'started_at',
  webrtc: 'started_at',
};
const WINDOW_MS = 6 * 3_600_000;
const MIN_WINDOW_MS = 60_000;
const UPSTREAM_RESULT_CAP = 10_000;
