import { normalizeBalance, normalizeTelnyxRecord } from './normalize.js';

/**
 * Thin HTTP client for the Telnyx v2 REST API.
 * Responsibilities: auth, pacing, timeouts, error classification,
 * pagination and normalisation. Resilience policy (retry, breaker,
 * coalescing) is applied one layer up so it can be shared by any provider.
 */
export class TelnyxClient {
  constructor({ config, pacer, logger }) {
    this.cfg = config.telnyx;
    this.pacer = pacer;
    this.logger = logger;
    this.kind = 'telnyx';
    this.unsupported = new Set();
  }

  async #get(path, query = {}) {
    await this.pacer.take();
    const url = new URL(this.cfg.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      const err = new Error(`network error on ${path}: ${e.message}`);
      err.retryable = true;
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`telnyx ${res.status} on ${path}: ${body.slice(0, 200)}`);
      err.status = res.status;
      err.retryable = res.status === 429 || res.status >= 500;
      // A 401/404 is a configuration problem, not an unhealthy dependency.
      err.countsAsFailure = err.retryable;
      const ra = Number(res.headers.get('retry-after'));
      if (res.status === 429 && Number.isFinite(ra)) err.retryAfterMs = ra * 1000;
      throw err;
    }
    return res.json();
  }

  /**
   * Walk pages until meta.total_pages. Telnyx silently caps page[size]
   * (50 on /detail_records), so short pages are NOT treated as the end.
   * `firstBody` lets a caller reuse a page-1 response it already fetched.
   */
  async #paginate(path, query, firstBody = null) {
    const out = [];
    for (let page = 1; page <= this.cfg.maxPages; page++) {
      const body = page === 1 && firstBody
        ? firstBody
        : await this.#get(path, { ...query, 'page[number]': page, 'page[size]': this.cfg.pageSize });
      const rows = Array.isArray(body.data) ? body.data : [];
      out.push(...rows);
      const totalPages = body.meta?.total_pages ?? body.meta?.page_count ?? 1;
      if (page >= totalPages || rows.length === 0) break;
      if (page === this.cfg.maxPages) this.logger?.warn('page cap reached, results truncated', { path, totalPages });
    }
    return out;
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

  async listDetailRecords({ since, until }) {
    const out = [];
    const types = [...new Set([...this.cfg.recordTypes, ...this.cfg.aiRecordTypes.filter((t) => !this.unsupported.has(t))])];
    for (const type of types) {
      let rows;
      try {
        rows = await this.#fetchType(type, since, until);
      } catch (err) {
        // An AI record type the account/API doesn't support must not block billing data.
        if (this.cfg.aiRecordTypes.includes(type) && err.status >= 400 && err.status < 500 && err.status !== 429) {
          this.unsupported.add(type);
          this.logger?.warn('AI record type unsupported, skipping', { type, status: err.status });
          continue;
        }
        throw err;
      }
      for (const raw of rows) {
        const rec = normalizeTelnyxRecord(raw, type);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  /**
   * Fetch one record type over [since, until). The time field differs per
   * type (call legs only accept started_at), and a single query is capped at
   * ~10k results upstream, so windows are split until each fits.
   */
  async #fetchType(type, since, until) {
    const field = TIME_FIELD[type] || 'created_at';
    const out = [];
    const stack = [];
    for (let t = since; t < until; t += WINDOW_MS) stack.push([t, Math.min(t + WINDOW_MS, until)]);
    stack.reverse();
    while (stack.length) {
      const [a, b] = stack.pop();
      const query = {
        'filter[record_type]': type,
        [`filter[${field}][gte]`]: new Date(a).toISOString(),
        [`filter[${field}][lt]`]: new Date(b).toISOString(),
        sort: field,
      };
      const first = await this.#get('/detail_records', { ...query, 'page[number]': 1, 'page[size]': this.cfg.pageSize });
      const total = first.meta?.total_results ?? 0;
      const fits = total < UPSTREAM_RESULT_CAP && Math.ceil(total / this.cfg.pageSize) <= this.cfg.maxPages;
      if (!fits && b - a > MIN_WINDOW_MS) {
        const mid = a + Math.floor((b - a) / 2);
        stack.push([mid, b], [a, mid]); // process the earlier half first
        continue;
      }
      out.push(...(await this.#paginate('/detail_records', query, first)));
    }
    return out;
  }
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
