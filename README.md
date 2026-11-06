# TLX/MON — Telnyx Billing Monitor

A self-hosted monitor for the **billing side of a Telnyx account**: balance, available credit, burn rate, runway, spend per product / number / country / billing group, a searchable ledger of billed records, and alerts. It also covers **Conversational AI usage** (which models are used most and which perform best) and generates a **statement for every calendar month**. It has two parts:

- **Backend:** Node.js + Express. It polls the Telnyx v2 API, indexes everything in memory with purpose-built data structures, and pushes changes to browsers over Server-Sent Events.
- **Frontend:** React + Vite. The landing page is a custom-shader Three.js scene. A **Click here** button dives into the dashboard, which is styled as a printed ledger: flat colours, no gradients, hand-drawn SVG charts.

It reads **only real data** from the Telnyx API. There is no simulator or demo mode: the server refuses to start without a `TELNYX_API_KEY`.

---

## Quick start

```bash
npm run install:all                                   # installs server/ and client/
cp .env.example .env                                  # then set TELNYX_API_KEY (required)
npm --prefix server run set-password                     # set the shared team password (prints it once)
npm run dev                                           # API on :8787, UI on http://localhost:5173
```

The server **refuses to start** until a login is configured: it fails closed rather than serving billing data unprotected. Use `-- you@example.com --prompt` to type your own password (min. 12 characters) instead of generating one.

Production (single process, Express serves the built UI):

```bash
npm run build && npm start # http://localhost:8787
npm test                   # backend unit tests (node:test, no deps)
```

Requirements: Node ≥ 20.12 (uses built-in `fetch`, `process.loadEnvFile`, `node:test`).

---

## Authentication (team login)

| | |
|---|---|
| Accounts | Any email ending in `@courserev.ai` (`LOGIN_EMAIL_DOMAIN`) plus **one shared password** (`SHARED_PASSWORD_HASH` in `.env`). The domain must match exactly: sub-domains and look-alikes such as `courserev.ai.evil.com` are rejected. There is no signup endpoint. Each session records the email that signed in, and logins are logged with it. |
| Password storage | scrypt (N=16384, r=8, p=1, random 16-byte salt). The plain password is never stored. `set-password` writes the hash and `chmod 600`s `.env`. To revoke access, rotate the password and restart (this ends every session). |
| Sessions | Server-side store; the cookie holds only a random 256-bit id. `HttpOnly`, `SameSite=Strict`, `Secure` when `COOKIE_SECURE=1` (set this behind HTTPS). Sliding 12 h expiry (`SESSION_TTL_HOURS`). |
| CSRF | SameSite=Strict, plus every non-GET request with a foreign `Origin` is rejected (403). |
| Brute force | Login is token-bucket limited per IP: 5 attempts, then 1 every 12 s (429 with `Retry-After`). Failures get a small randomised delay. |
| Enumeration | There are no per-user accounts to enumerate. A wrong domain gets a clear "use your @courserev.ai email" message (the domain is public); a wrong password gets a generic error after a randomised delay. |
| Coverage | Every `/api/*` route except `/health`, `/ready` and `/auth/*` requires a session, including the SSE stream and all CSV/JSON downloads. |
| Frontend | `/login` page. The dashboard shell checks `/api/auth/me` before rendering, and any later 401 (expired session) sends you back to `/login?next=…`. Only `/dashboard…` paths are accepted as `next` (no open redirect). |

Sessions live in memory, so a server restart signs you out. To scale out, move them to Redis next to the cache.

---

## 1. System architecture

```
                 ┌──────────────────────────── Browser ─────────────────────────────┐
                 │  /            Landing (Three.js, lazy chunk)                     │
                 │  /dashboard   Dashboard (React, lazy chunk, no three.js)         │
                 │      │ REST (fetch)                  ▲ SSE  /api/stream          │
                 └──────┼───────────────────────────────┼───────────────────────────┘
                        ▼                               │
┌───────────────────────────────────── Node process ────┼──────────────────────────┐
│  HTTP layer   requestContext → TokenBucket rate limit → router → error handler   │
│               read endpoints wrapped in LRU response cache (key = url + version) │
│                        │                               │                         │
│  Read side    Analytics (overview, series, split, balance LTTB)   SseHub ◄──┐    │
│               BillingStore.query / top / suggest                            │    │
│                        │ reads                                              │    │
│               ┌────────▼─────────────── BillingStore ───────────────┐       │    │
│               │ records[] (time-sorted)   byId Map    Trie          │       │    │
│               │ TimeWindowSeries (segment tree) total + per product │       │    │
│               │ balanceHistory RingBuffer   groups Map   version    │       │    │
│               └────────▲────────────────────────────────────────────┘       │    │
│                        │ ingest / evict                                     │    │
│  Write side   BillingSync ── publish ──────────► EventBus ─────────────────┘    │
│                  │                                  │                            │
│                  │ singleFlight → circuitBreaker → retry(backoff+jitter)         │
│                  ▼                                  └─► AlertEngine (rules)      │
│               Provider: TelnyxClient (PacedBucket)                               │
│                  ▲                                                               │
│               Scheduler: records · balance · groups · alerts · housekeeping      │
└──────────────────┼───────────────────────────────────────────────────────────────┘
                   ▼
            api.telnyx.com/v2   /balance  /billing_groups  /detail_records
```

### Design principles

| Principle | Where |
|---|---|
| **Composition root / dependency injection.** Every object is built once in `server/src/index.js` and passed in. No module reaches for globals, so each piece can be tested on its own. | `index.js` |
| **CQRS-style split.** Writers (`BillingSync`) mutate the store. Readers (`Analytics`, `BillingStore.query/top`) are pure functions of its state. | `services/` |
| **Anti-corruption layer.** Upstream JSON is normalised into one internal `BillingRecord` shape at the edge. Nothing else knows Telnyx field names. | `providers/normalize.js` |
| **Ports & adapters.** `TelnyxClient` exposes a small provider interface (`getBalance`, `listBillingGroups`, `listDetailRecords`), so the rest of the system never calls HTTP directly. | `providers/` |
| **Event-driven fan-out.** Producers publish to an `EventBus`. The SSE hub and alert engine subscribe. Replacing the bus with Redis/NATS is the scale-out path. | `core/eventBus.js` |
| **Durable read models.** Monthly rollups are a second projection of the same record stream. They are persisted to disk so reports outlive the 35-day raw-record retention and process restarts. | `services/monthlyRollups.js` |
| **Version-keyed caching.** Every store mutation bumps `version`, and cache keys include it, so the cache never needs explicit invalidation. | `api/middleware.js` |

### Resilience: the upstream call stack

Every Telnyx call goes through the same layered policy (`services/billingSync.js`):

```
singleFlight.do(key)            ← concurrent identical calls share one promise
  └ circuitBreaker.exec()       ← CLOSED → OPEN (fail fast) → HALF_OPEN (1 probe) → CLOSED
      └ retry(backoff + jitter) ← delay = random(0, min(cap, base·2^n)); honours Retry-After
          └ PacedBucket.take()  ← outbound pacing so we stay under Telnyx rate limits
              └ fetch(timeout)  ← AbortSignal.timeout, errors classified retryable / not
```

- **Error classification:** 429 and 5xx are retryable and count against the breaker. 401/404 are configuration errors: they are not retried and don't trip the breaker.
- **Scheduler:** uses `setTimeout` chaining, so a slow run never overlaps itself. ±10% jitter keeps jobs from aligning. Consecutive failures back off exponentially (capped at 10 min), and p50/p95 run latencies are kept in a ring buffer.
- **Incremental sync with a high-water mark:** each poll asks for `[watermark − 5 min, now)`. The overlap catches late-arriving records, and the primary-key index drops duplicates, which makes ingest idempotent.
- **Back-pressure:** an SSE client whose socket buffer passes 1 MiB is disconnected instead of growing memory without limit.
- **Bounded memory:** records older than 35 days are evicted, the time series is a fixed circular array, and balance history is a ring buffer.
- **Graceful shutdown:** SIGINT/SIGTERM stop the scheduler, close the SSE streams and drain the HTTP server.
- **Probes:** `/api/health` (liveness) and `/api/ready` (readiness: first balance loaded).

---

## 2. Data structures & algorithms

All hand-written in `server/src/dsa/` and covered by `server/test/dsa.test.js`.

| Structure / algorithm | File | Used for | Complexity |
|---|---|---|---|
| **LRU cache with TTL** (HashMap + doubly linked list) | `LRUCache.js` | API response cache | get/set/evict O(1) |
| **Circular segment tree** (`TimeWindowSeries`) | `SegmentTree.js` | "How much was spent between t₁ and t₂": hourly buckets over a sliding 36-day window, one tree for the total and one per product | add O(log n), range sum O(log n) |
| **Binary search** (`lowerBound` / `upperBound`) | `search.js` | Slicing the time-sorted record log to `[from, to)`; finding the balance snapshot from 1 h ago | O(log n) |
| **Trie** (token → id set) | `Trie.js` | Type-ahead search over numbers, countries, products and billing groups; autocomplete | insert O(L), prefix O(P + k) |
| **Min-heap top-K** | `MinHeap.js` | Top spenders by number / country / group without sorting everything | O(n log k) |
| **Hash aggregation** | `billingStore.top` | Group-by over the time slice before top-K | O(n) |
| **Ring buffer** | `RingBuffer.js` | Balance snapshots, job latencies, breaker outcome window, alert history | push O(1), fixed memory |
| **Token bucket** | `TokenBucket.js` | Per-client API rate limit (lazy refill, no timers) and outbound pacing | O(1) |
| **Welford mean/std** | `search.js` | Spend-spike z-score (last hour vs prior 168 h) | one pass, O(n) |
| **LTTB downsampling** | `services/analytics.js` | Balance history down to 240 points while keeping its peaks and dips | O(n) |
| **Nearest-rank percentile** | `RingBuffer.js` | Scheduler p50/p95; per-model AI latency p50/p95 | O(n log n) |
| **Secondary time index** | `billingStore.aiRecords` | AI conversations kept in their own time-sorted array, so AI analytics binary-search ~9% of the data instead of scanning the full log | O(log n + k) |
| **Indexed min-heap** | `SpaceSaving.js` | Heap plus key→position map, so any key's priority can be increased in place | O(log k) |
| **Space-Saving heavy hitters** (weighted) | `SpaceSaving.js` | "Top numbers" for each month in bounded memory, however many distinct numbers there are. True heavy hitters are always kept, and each overestimate is bounded by a stored `error` | O(log k) per record, O(k) memory |
| **Streaming generator export** | `billingStore.scan()` + `/records/export.csv` | Filtered ledger CSV of up to 200k rows, streamed in 1,000-row chunks that wait for socket `drain` (back-pressure), so memory stays flat | O(n) time, O(1) extra memory |
| **One-pass 2-D binning** | `analytics.heatmap()` | Weekday × hour spend grid, averaged per weekday occurrence | O(n) |
| **Greedy label placement** | `client/.../ModelScatter.jsx` | Scatter labels flip sides to avoid markers and are nudged apart vertically to avoid each other | O(n²), n = models |

### The record query planner

`BillingStore.query()` picks between two plans and reports which one it used. The dashboard shows it as `plan index · scanned 814 · 0.4 ms`.

- **index:** the text terms resolve through the trie to a candidate id set (multiple terms are intersected by iterating the smaller set). If that set is smaller than the time slice, it fetches those ids, filters by time and sorts.
- **scan:** otherwise it binary-searches the time slice and walks it newest-first, filtering as it goes.

### Ingest path (per batch)

1. Sort the batch by timestamp (O(b log b)), so appends are the common case.
2. Dedupe via the `byId` map (O(1)).
3. Append, or for a late arrival `upperBound` + splice.
4. Index tokens into the trie.
5. Add cost to the total segment tree and the product's tree.
6. Bump `version`, which invalidates cached reads.
7. Publish a `records` event, which reaches the SSE hub and the browser.

### Monthly rollups: exactly-once across restarts

The raw log only holds 35 days, so each record is also folded into a per-month aggregate as it is ingested. That aggregate covers totals, product/country/group/direction, per-day series, AI model and assistant stats, a Space-Saving sketch of top numbers, and balance open/close. It is flushed to `server/data/rollups*.json` every 30 s and on shutdown, written to a temp file and renamed so the file is never half-written.

- `meta.highWater` (persisted) is the newest record timestamp ever counted. On boot it becomes `bootHighWater`, and live ingest only counts store-new records newer than it. The post-restart backfill that re-reads 30 days is therefore not double-counted (covered by a unit test).
- `meta.liveFrom` is where the first live sync began. **History** before that (default: the previous 3 months) is filled by `BillingSync.backfillHistory()`. It works one day at a time, in the background, through the same breaker/retry/coalescing stack, and feeds only the rollups. Progress is persisted in `meta.historyDoneThrough`, so an interrupted backfill resumes. A scheduler job retries it every 5 min until it completes.
- Each month's report is tagged **complete**, **in progress** (current month, with a projection) or **partial** (data starts mid-month, or the backfill hasn't reached it yet).

### Conversational AI analytics

AI conversations are a product (`ai`) in the same record stream, with extra fields: `model`, `assistantId`, `channel`, `turns`, tokens, `latencyMs`, `outcome` and `durationSec`. `services/aiAnalytics.js` computes, over a range:

- totals: conversations, spend, $/conversation, $/resolved, resolution, transfer and abandon rates, median latency
- **models ranked by conversation volume** (heap top-K), with per-model p50/p95 latency, cost and quality metrics
- a **scorecard** naming a winner per axis: *most used*, *best resolution*, *best value* (lowest $ per resolved conversation) and *fastest* (p50). "Which model is better" depends on what you optimise for, so there is no single blended score. Models need at least 20 conversations to qualify.
- conversations per bucket for the top 5 models (rest grouped as "other"), outcome and channel splits, and per-assistant model mix

---

## 3. API

All responses are JSON unless noted. Read endpoints set `x-cache: HIT|MISS`.

**Date ranges.** Every ranged endpoint accepts either `range=24h|7d|30d` or a custom `from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, UTC, epoch ms also accepted). Custom windows are limited to the 35 days of raw data (older months live in Reports). Bucket size adapts to the span: ≤2 days hourly, ≤14 days 6-hourly, otherwise daily.

| Method | Path | Description |
|---|---|---|
| GET | `/api/overview` | balance, available credit, pending, 24 h spend and change, today, MTD, projected month, 7-day avg/day, runway |
| GET | `/api/spend/series?range=` | per-bucket spend stacked by product (1 h / 6 h / 1 d buckets) |
| GET | `/api/spend/products?range=` | totals and shares per product |
| GET | `/api/top?by=destination\|country\|billingGroup&k=8&range=` | heap-based top-K |
| GET | `/api/records?q=&product=&country=&direction=&range=&limit=&before=` | ledger search with cursor pagination and plan metadata |
| GET | `/api/search/suggest?q=` | trie autocomplete |
| GET | `/api/balance/history?range=` | LTTB-downsampled balance snapshots (`est` = reconstructed) |
| POST | `/api/auth/login` · `/api/auth/logout` | sign in (sets the session cookie) / sign out |
| GET | `/api/auth/me` | current session or 401 |
| GET | `/api/spend/heatmap?range=` | average spend per weekday × UTC hour |
| GET | `/api/spend/pace` | cumulative spend by day, this month vs last, with projection |
| GET | `/api/records/export.csv?…` | the ledger as CSV, honouring `q`, `product`, `country`, `direction` and the date range |
| GET | `/api/billing-groups` | billing groups |
| GET | `/api/ai/overview?range=` | AI totals, ranked models, scorecard, per-model series, outcomes, channels, assistants |
| GET | `/api/reports` | months available (newest first) with status, plus history-backfill progress |
| GET | `/api/reports/:YYYY-MM` | full monthly statement (JSON): summary and change vs previous month, daily series, products, countries, groups, top numbers, AI models and assistants, coverage |
| GET | `/api/reports/:YYYY-MM/csv` | the same statement as a sectioned CSV download |
| GET | `/api/reports/summary.csv` | one row per month: the "every month" export |
| GET / PUT | `/api/alerts`, `/api/alerts/thresholds` | active and recent alerts; update `lowBalance`, `runwayDays`, `spikeZ` |
| POST | `/api/sync` | force a records and balance sync (charged 10 rate-limit tokens) |
| GET | `/api/system` | internals: breaker, cache, single-flight, store, jobs, SSE, limiter, memory |
| GET | `/api/stream` | SSE: `hello`, `balance`, `records`, `alert`, `breaker` |
| GET | `/api/health`, `/api/ready` | probes |

### Alert rules (`services/alertEngine.js`)

These are stateful: an alert fires once, stays active while its condition holds, and resolves when it clears.

| Rule | Severity | Condition |
|---|---|---|
| `low_balance` | critical | available credit < threshold |
| `runway` | warning | available ÷ 7-day average daily spend < N days |
| `spend_spike` | warning | z-score of the last full hour vs the prior 7 days ≥ threshold |
| `upstream_down` | critical | circuit breaker OPEN |
| `stale_data` | warning | no successful record sync for 5× the poll interval |

### Telnyx endpoints used

`GET /v2/balance`, `GET /v2/billing_groups`, `GET /v2/ai/assistants`, and `GET /v2/detail_records` (filtered by `record_type` and `created_at` range, paginated). Billing record types come from `TELNYX_RECORD_TYPES` and AI record types from `TELNYX_AI_RECORD_TYPES`.

AI access is optional and fails soft. If the account returns a 4xx for an AI record type or for the assistants endpoint, that source is skipped (logged once) and billing data keeps flowing. AI field names are read defensively (`model`/`llm_model`, `assistant_id`, `input_tokens`/`prompt_tokens`, `latency_ms`, `outcome`, …). If your AI records use other names, adjust the `product === 'ai'` block in `normalize.js`. Detail-record fields vary by product, so `normalize.js` reads them defensively (`cost`, `cld`/`to`, `billed_sec`, `parts`, `country_code`, …). If your account returns different field names, that file is the one place to adjust.

---

## 4. Frontend

```
client/src/
├─ main.jsx               router + route-level code splitting (React.lazy)
├─ layout/AppLayout.jsx   nav bar (sliding indicator, alert badge), live-stream
│                         context shared by every section, page transitions
├─ three/
│  ├─ GlobeScene.js       scene graph, boot pipeline, interaction, dive transition
│  └─ shaders.js          GLSL: simplex noise, point cloud, arc packets, stars
├─ pages/
│  ├─ Landing.jsx         3D page, boot loader, "Click here" → dive → /dashboard
│  ├─ Login.jsx           team sign-in (@courserev.ai + shared password)
│  ├─ Dashboard.jsx       Overview: figures, charts, ledger, internals
│  ├─ AiPage.jsx          Conversational AI: most-used model, scorecard,
│  │                      cost-vs-resolution scatter, leaderboard, assistants
│  └─ Reports.jsx         month index + printable monthly statement
├─ components/ai/         ModelBars, ModelScatter, Leaderboard
├─ components/charts/     Donut/Pie, Heatmap, PaceChart, Histogram, Radar,
│                         MonthlyTrend, a11y (keyboard model, live region, data tables)
├─ components/RangePicker.jsx   presets + custom date popover
├─ components/            Panel/Figure/Tabs/Skeleton, SpendChart, BalanceChart,
│                         Breakdowns (split + top), Ledger, AlertsPanel,
│                         SystemPanel, Ticker
├─ lib/                   api (fetch + in-flight store), stream (SSE), hooks, format
└─ styles/                base tokens, landing, dashboard (flat colours only)
```

### The 3D landing page

- **64,000-node Fibonacci sphere** rendered as GPU points with a custom `ShaderMaterial`.
- **Procedural continents:** a 5-octave value-noise fBm is computed on the CPU, then thresholded at its **70th percentile**, so coverage is exactly 30% land regardless of the noise.
- **Vertex shader effects:** 3D simplex noise "breathing" on land, a latitude scan band, a radial **pointer ripple** (ray-cast hit point converted to globe-local space), a boot-time reveal from the pole, and the **dive burst** that throws points outward along noise-perturbed normals.
- **Hubs by farthest-point sampling** (each new hub maximises its distance to the existing ones), connected by `TubeGeometry` arcs. A fragment shader draws a travelling packet with a fading tail, and each arc "writes itself on" during the intro.
- **96 instanced pollers** (`InstancedMesh`, one draw call) on three inclined orbital shells, oriented along their direction of travel.
- A camera-facing instrument bezel (tick ring, silhouette, sweep), graticule, depth-scaled star field and mouse parallax.
- **Drag to rotate with inertia** that relaxes back to auto-spin, plus a live lat/lon readout under the cursor.
- The boot pipeline builds geometry in chunks across frames and reports real progress to the loader, then calls `renderer.compile()` so there's no first-frame shader hitch.
- **Click here** starts a camera dolly with FOV widening, the particle burst, a spin-up and a paper-coloured wipe, then routes to `/dashboard` (prefetched on hover).
- Respects `prefers-reduced-motion`, falls back gracefully without WebGL, and disposes all GPU resources on unmount.

### Dashboard design choices (why it doesn't look generated)

- Styled as a printed ledger: warm paper background, ink black, a single signal orange, and hairline 1px rules created with grid `gap` over a rule-coloured background. There are no cards, shadows, rounded corners or gradients.
- IBM Plex Sans Condensed for labels and IBM Plex Mono with tabular numerals for every figure.
- Charts are hand-written SVG (no chart library): stacked bars with a blinking "now" cap, a balance line with the reconstructed portion dashed, and inline meters.

### Navigation and pages

| Route | Page |
|---|---|
| `/` | 3D landing: **Click here** dives into the dashboard |
| `/login` | sign in (the only account is the one in `.env`) |
| `/dashboard` | **Overview**: one date-range picker (presets or custom) drives spend over time, the product donut, top spend, balance, the heatmap and the ledger. Also month pace, alerts, the ledger with **Export CSV** (exactly the filtered rows), and backend internals |
| `/dashboard/ai` | **Conversational AI**: date range, most-used model, scorecard and scatter, **radar** model profile, **latency histogram**, conversations by model, **outcome donut and channel pie**, sortable leaderboard, assistants |
| `/dashboard/reports/:month` | **Reports**: a **monthly trend** chart (click a column to open that month), the month list, and the statement (with product donut). Print/PDF, CSV and JSON downloads; "All months · CSV" exports one row per month |

The nav bar is sticky. A single accent bar slides to the active section, the Overview tab shows a badge with the active-alert count, and on narrow screens the links become a scrollable second row. The live SSE connection lives in the layout, so switching sections doesn't reconnect.

Statements have print styles: navigation, the month list and buttons are hidden, the page is white, and sections avoid page breaks. **Print / Save PDF** produces a clean document.

### Charts

| Chart | Where | Notes |
|---|---|---|
| Stacked bars | spend over time, conversations by model, daily spend in statements | per product / per model |
| **Donut** | where the money goes, AI outcomes, statement product split | segments sweep in; hover, legend or arrow keys fill the centre |
| **Pie** | AI channel split (voice vs chat) | same component, `variant="pie"` |
| **Heatmap** | when you spend (weekday × hour) | a real `<table>`; 6 discrete colour steps, not a gradient |
| **Month-pace line** | overview | this month vs last (dashed) plus a projection (dotted) |
| **Histogram** | AI response latency | 100 ms bins; all models or each of the top 3; median marker |
| **Radar** | AI model profile | volume, resolution, value, speed, containment, each scaled so the best model reaches the rim |
| Scatter | cost vs resolution | marker-aware label placement |
| **Monthly trend** | Reports | one stacked column per month; each column links to its statement |
| Line | balance | estimated history dashed |

### Hero header

Every dashboard section opens with a full-width, rounded hero (`layout/AppLayout.jsx`, `styles/hero.css`) built from three layers:

1. **Image:** `client/public/hero-datacenter.jpg` (2400×1021): a photo of server racks in a data centre, sharp racks and status LEDs on the right and soft dark aisles on the left behind the title. It zooms in on load, drifts slowly, and pans to a different crop for Overview, AI and Reports. **Credit and licence:** "Wikimedia Foundation Servers-8055 13" by [Victorgrigas](https://commons.wikimedia.org/wiki/File:Wikimedia_Foundation_Servers-8055_13.jpg), [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), via Wikimedia Commons, resized and recompressed. The licence requires the visible credit link in the hero (`.hero__credit`), so keep it while this photo is used. To use another image, replace the file and update `.hero__img` and the credit.
2. **Dark gradient overlay:** horizontal and vertical gradients that keep the title legible over any image. This is the one deliberate gradient in the UI; everything else stays flat.
3. **Floating content:** a translucent, blurred nav bar plus the page's own title, controls and (on Overview) the live ticker. Pages render into the hero through a React portal (`<HeroContent>`), so they keep owning their state (e.g. the range picker).

The hero is always dark, whatever the theme: a scoped `.on-dark` token set makes every control placed on it adapt automatically. When you scroll past it, the same nav pins to the top as a floating bar (IntersectionObserver). The nav lives outside `.hero`'s isolated stacking context so it can sit above the page when pinned. Reduced-motion turns off the zoom and drift, and the hero is hidden when printing.

### Theme

Light and dark themes come from CSS custom properties: surfaces, ink, rules, signal colours, **every chart series** (`--p-*` for products, `--m-*` for models, `--heat-*`) and tooltips. Charts never hard-code a colour, so they follow the theme instantly. The toggle (nav bar and login page) is saved per browser. With no saved choice the OS setting is used, applied before first paint so there's no flash. Statements always **print in light**. The 3D landing page stays dark by design.

### Accessibility

- **Keyboard charts:** each chart is one Tab stop. ←/→ (↑/↓) step through points, Home/End jump, Esc clears. The focused point gets the same tooltip as a mouse hover, and its value is announced through an `aria-live` region. The heatmap supports 2-D arrow movement.
- **Screen readers:** every chart has a descriptive `aria-label` and a visually hidden data table with the underlying numbers (inside a clipped wrapper, so it can't cause sideways scrolling).
- **Tabs and range presets** follow the WAI-ARIA tabs pattern with roving tabindex: one Tab stop, arrow keys change the selection.
- **Ledger search** is an ARIA combobox: ↓/↑ move through suggestions, Enter picks one, Esc closes.
- **Range picker** popover: focus moves into it on open, Esc or an outside click closes it and returns focus to the trigger, and validation errors use `role="alert"`.
- A **Skip to content** link, `:focus-visible` rings, and `prefers-reduced-motion` support everywhere.

### Loaders and animation

| Kind | Implementation |
|---|---|
| Boot loader | counter that chases real progress, boot log, segmented tick bar, lifts away on completion |
| Module loader | stepped square spinner while a lazy route chunk downloads; a per-section loader inside the layout |
| Statement loader | document-shaped skeleton with "compiling statement for …" |
| History backfill | progress bar with the days rolled up so far and the current month, polled until done |
| Top progress bar | driven by a global in-flight request counter (`useSyncExternalStore`) |
| Skeletons | stepped blink (no shimmer gradient) |
| Panel refresh | spinner beside the title; the body dims only when the query changes, not on live ticks |
| Buttons | inline spinner for Sync now, Apply and Load older |
| Entrance | staggered `clip-path` wipe per panel, header slide-down |
| AI page | the model name wipes in, 50 share blocks fill one after another, award cells and scatter points stagger in, leaderboard rows slide in |
| Reports | the month list staggers in, the active month indents, the statement rises in, and the status stamp lands |
| Data motion | count-up figures with an accent marker on change, bars growing from the baseline, line draw-on, meters filling, ledger rows flashing as they arrive, scrolling ticker tape, pulsing live indicator |

---

## 5. Configuration

See `.env.example`. Key settings:

| Variable | Default | Notes |
|---|---|---|
| `TELNYX_API_KEY` | — (required) | Telnyx v2 key; the server exits if it is missing |
| `TELNYX_RECORD_TYPES` | `messaging,call-control,sip-trunking` | detail record types to ingest (call-control and sip-trunking are separate charges on the same leg) |
| `TELNYX_BACKFILL_DAYS` | 7 | first-sync window |
| `POLL_BALANCE_MS` / `POLL_RECORDS_MS` | 30 s / 60 s | |
| `ALERT_LOW_BALANCE`, `ALERT_RUNWAY_DAYS`, `ALERT_SPIKE_Z` | 250 / 7 / 3 | also editable in the UI |
| `LOGIN_EMAIL_DOMAIN` | `courserev.ai` | email domain allowed to sign in |
| `SHARED_PASSWORD_HASH` | — (required) | scrypt hash of the shared password; set with `npm --prefix server run set-password` |
| `SESSION_TTL_HOURS` | 12 | sliding session lifetime |
| `COOKIE_SECURE` | off | set to `1` when served over HTTPS |
| `TELNYX_AI_RECORD_TYPES` | `ai-voice-assistant` | detail record types holding AI conversations (skipped if unsupported) |
| `REPORT_HISTORY_MONTHS` | 3 | how many past months to backfill for reports |
| `REPORTS_FILE` | `server/data/rollups.json` | where monthly rollups persist |

---

## 6. Scaling beyond one process

The state lives in a single process on purpose: one poller per Telnyx account avoids duplicate API usage. To scale:

1. **Split roles.** Run one *ingest worker* (scheduler + sync) and N stateless *API replicas*.
2. **Move the bus.** Replace `EventBus` with Redis pub/sub or NATS. API replicas subscribe and fan out over SSE.
3. **Persist the log.** (Monthly rollups are already persisted; the raw log isn't.) Write normalised records to Postgres/TimescaleDB (or ClickHouse) partitioned by day, and keep hourly rollups as the persistent form of the segment trees.
4. **Share the cache.** Move the LRU to Redis, keeping the `version` key scheme.
5. **Leader election** (a Redis lock or a Postgres advisory lock) so only one worker polls Telnyx.

---

## 7. Project layout

```
.
├─ server/
│  ├─ src/
│  │  ├─ index.js            composition root, HTTP server, shutdown
│  │  ├─ config.js           env parsing
│  │  ├─ core/               logger, event bus
│  │  ├─ dsa/                LRU, heap, indexed heap + Space-Saving, ring buffer, trie,
│  │  │                      segment tree, search, token bucket
│  │  ├─ infra/              circuit breaker, retry, single-flight, scheduler
│  │  ├─ providers/          telnyxClient, normalize
│  │  ├─ services/           billingStore, billingSync, analytics, alertEngine,
│  │  │                      aiAnalytics, monthlyRollups, reports
│  │  ├─ auth/               scrypt, sessions, login/logout/me, origin check
│  │  └─ api/                routes, middleware, sseHub
│  ├─ scripts/set-password.mjs   set/rotate the shared password
│  └─ test/dsa.test.js
├─ client/                   Vite + React + three
├─ scripts/dev.mjs           runs both dev servers
└─ .env.example
```
