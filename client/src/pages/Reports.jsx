import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useResource } from '../lib/api.js';
import {
  money, moneySmart, num, pct, signedPct, monthName, productColor, productLabel,
  shortModel, splitModel, modelColors, ms, utcDate, utcTime,
} from '../lib/format.js';
import { Skeleton, SkeletonRows } from '../components/ui.jsx';
import SpendChart from '../components/SpendChart.jsx';
import Donut from '../components/charts/Donut.jsx';
import MonthlyTrend from '../components/charts/MonthlyTrend.jsx';
import '../styles/reports.css';
import { HeroContent } from '../layout/AppLayout.jsx';

const STATUS = {
  complete: 'Complete',
  in_progress: 'In progress',
  partial: 'Partial',
};

function Delta({ v, invert = false }) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="delta mono dim">—</span>;
  const up = v > 0;
  const bad = invert ? !up : up; // more spend = bad
  return <span className={`delta mono ${Math.abs(v) < 0.005 ? '' : bad ? 'delta--bad' : 'delta--good'}`}>{up ? '▲' : '▼'} {signedPct(v)}</span>;
}

/* --------------------------------------------------------------- index */
function MonthList({ data, active }) {
  if (!data) return <SkeletonRows rows={6} h={46} />;
  const bf = data.backfill;
  return (
    <>
      {bf?.running && (
        <div className="backfill" role="status">
          <p className="mono"><span className="spin-square" /> Building history · {bf.month ?? '…'}</p>
          <div className="backfill__bar"><i style={{ transform: `scaleX(${bf.total ? bf.done / bf.total : 0})` }} /></div>
          <p className="mono dim">{bf.done}/{bf.total} days rolled up</p>
        </div>
      )}
      <ol className="months">
        {data.items.map((m, i) => (
          <li key={m.month} style={{ '--d': `${i * 50}ms` }}>
            <Link to={`/dashboard/reports/${m.month}`} className={`month ${m.month === active ? 'is-active' : ''}`}>
              <span className="month__name">{monthName(m.month)}</span>
              <span className={`month__status mono status--${m.status}`}>{STATUS[m.status]}</span>
              <span className="month__cost mono">{money(m.cost, data.currency)}</span>
              <span className="month__meta mono">{num(m.count)} rec · {num(m.aiConversations)} AI</span>
            </Link>
          </li>
        ))}
      </ol>
      {!data.items.length && <p className="empty mono">No months yet: data is still syncing.</p>}
    </>
  );
}

/* ----------------------------------------------------------- statement */
function DocSkeleton({ month }) {
  return (
    <div className="doc doc--loading" role="status" aria-label="Generating report">
      <p className="doc-loading mono"><span className="spin-square" /> compiling statement{month ? ` for ${monthName(month)}` : ''}…</p>
      <Skeleton h={14} w="30%" />
      <Skeleton h={56} w="60%" className="mt16" />
      <div className="doc-sk-grid">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={64} />)}</div>
      <Skeleton h={220} className="mt16" />
      <SkeletonRows rows={8} h={18} />
    </div>
  );
}

function Section({ n, title, children, note }) {
  return (
    <section className="doc-sec">
      <header className="doc-sec__h"><span className="mono">{n}</span><h3>{title}</h3>{note && <span className="mono dim doc-sec__note">{note}</span>}</header>
      {children}
    </section>
  );
}

function BreakdownTable({ rows, cur, label, color }) {
  return (
    <table className="tbl tbl--compact">
      <thead><tr><th>{label}</th><th className="r">Spend</th><th className="r">Share</th><th className="r">Records</th><th className="r">vs prev</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{color && <i className="sq" style={{ background: color(r.key) }} />}{r.label}</td>
            <td className="r mono">{money(r.cost, cur)}</td>
            <td className="r mono"><span className="share-cell"><span className="meter meter--inline"><i style={{ width: `${r.share * 100}%` }} /></span>{pct(r.share)}</span></td>
            <td className="r mono">{num(r.count)}</td>
            <td className="r"><Delta v={r.change} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Statement({ r }) {
  const cur = r.currency;
  const s = r.summary;
  const cov = r.coverage;
  const colorFor = useMemo(() => modelColors(r.ai.models.map((m) => m.model)), [r]);
  const chart = useMemo(() => ({
    range: r.month,
    stepMs: 86_400_000,
    products: [...new Set(r.daily.flatMap((d) => Object.keys(d.byProduct)))],
    points: r.daily.map((d) => ({ t: Date.parse(`${d.day}T00:00:00Z`), total: d.cost, count: d.count, byProduct: d.byProduct })),
  }), [r]);
  const top = r.ai.models[0];
  const hasError = r.topNumbers.some((x) => x.maxError > 0);
  const end = new Date(cov.to - 1);

  return (
    <article className="doc" aria-label={`Statement for ${monthName(r.month)}`}>
      <header className="doc-head">
        <div>
          <p className="doc-kicker mono">Monthly billing statement · No. {r.month}</p>
          <h2 className="doc-title">{monthName(r.month)}</h2>
          <p className="doc-meta mono">
            {`Period ${utcDate(cov.from)} – ${utcDate(end.getTime())} ${end.getUTCFullYear()} (UTC)`}
            {' · Source Telnyx API'}
            {` · Generated ${utcDate(r.generatedAt)} ${utcTime(r.generatedAt, false)} UTC`}
          </p>
        </div>
        <span className={`stamp mono status--${cov.status}`}>{STATUS[cov.status]}</span>
      </header>

      <div className="doc-actions">
        <button type="button" className="btn" onClick={() => window.print()}>Print / Save PDF</button>
        <a className="btn btn--ghost" href={`/api/reports/${r.month}/csv`} download>Download CSV</a>
        <a className="btn btn--ghost" href={`/api/reports/${r.month}`} download={`tlxmon-statement-${r.month}.json`}>Download JSON</a>
      </div>

      <Section n="1" title="Summary">
        <dl className="doc-figs">
          <div><dt>Total spend</dt><dd className="mono">{money(s.cost, cur)}</dd><dd className="doc-fig-sub"><Delta v={s.change} /> <span className="dim mono">vs {s.prevCost !== null ? money(s.prevCost, cur, 0) : '—'}</span></dd></div>
          <div><dt>Billed records</dt><dd className="mono">{num(s.count)}</dd><dd className="doc-fig-sub mono dim">{num(s.failed)} failed · {pct(s.count ? s.failed / s.count : 0)}</dd></div>
          <div><dt>Average per day</dt><dd className="mono">{money(s.avgDaily, cur)}</dd><dd className="doc-fig-sub mono dim">{s.projected !== null ? `projected ${money(s.projected, cur, 0)}` : `${Math.round(cov.elapsedDays)} days covered`}</dd></div>
          <div><dt>Peak day</dt><dd className="mono">{s.peakDay ? money(s.peakDay.cost, cur) : '—'}</dd><dd className="doc-fig-sub mono dim">{s.peakDay ? utcDate(Date.parse(s.peakDay.day)) : ''}</dd></div>
          <div><dt>AI conversations</dt><dd className="mono">{num(r.ai.conversations)}</dd><dd className="doc-fig-sub"><Delta v={r.ai.prevConversations ? (r.ai.conversations - r.ai.prevConversations) / r.ai.prevConversations : null} invert /> <span className="dim mono">{money(r.ai.cost, cur)}</span></dd></div>
          <div><dt>Balance open → close</dt><dd className="mono">{s.balanceOpen !== null ? `${money(s.balanceOpen, cur, 0)} → ${money(s.balanceClose, cur, 0)}` : '—'}</dd><dd className="doc-fig-sub mono dim">{s.balanceOpen !== null ? 'from polled snapshots' : 'not polled this month'}</dd></div>
        </dl>
      </Section>

      <Section n="2" title="Daily spend" note="stacked by product">
        <SpendChart data={chart} currency={cur} />
      </Section>

      <Section n="3" title="Spend by product">
        <div className="doc-donut">
          <Donut items={r.products.map((p) => ({ key: p.key, value: p.cost }))} colorFor={productColor} labelFor={productLabel}
            format={(v) => money(v, cur, 0)} caption={`Spend by product, ${monthName(r.month)}`} size={170} />
        </div>
        <BreakdownTable rows={r.products.map((p) => ({ ...p, label: productLabel(p.key) }))} cur={cur} label="Product" color={productColor} />
      </Section>

      <div className="doc-two">
        <Section n="4" title="Top countries">
          <BreakdownTable rows={r.countries.map((c) => ({ ...c, label: c.key }))} cur={cur} label="Country" />
        </Section>
        <Section n="5" title="Billing groups">
          <BreakdownTable rows={r.groups} cur={cur} label="Group" />
        </Section>
      </div>

      <Section n="6" title="Top numbers by spend" note={hasError ? 'bounded estimate, see notes' : 'exact'}>
        <table className="tbl tbl--compact">
          <thead><tr><th className="rank">#</th><th>Number</th><th className="r">Spend</th><th className="r">Records</th>{hasError && <th className="r">± max</th>}</tr></thead>
          <tbody>
            {r.topNumbers.map((x, i) => (
              <tr key={x.number}>
                <td className="rank mono">{String(i + 1).padStart(2, '0')}</td>
                <td className="mono">{x.number}</td>
                <td className="r mono">{moneySmart(x.cost, cur)}</td>
                <td className="r mono">{num(x.count)}</td>
                {hasError && <td className="r mono dim">{x.maxError ? moneySmart(x.maxError, cur) : '0'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section n="7" title="Conversational AI">
        {top ? (
          <>
            <p className="doc-callout">
              Most used model: <b>{splitModel(top.model).name}</b> <span className="mono dim">({splitModel(top.model).vendor})</span>,
              {' '}{pct(top.share)} of {num(r.ai.conversations)} conversations.
              {r.ai.scorecard.bestResolution && <> Best resolution: <b>{shortModel(r.ai.scorecard.bestResolution.model)}</b> ({pct(r.ai.scorecard.bestResolution.v)}).</>}
              {r.ai.scorecard.bestValue && <> Best value: <b>{shortModel(r.ai.scorecard.bestValue.model)}</b> ({moneySmart(r.ai.scorecard.bestValue.v, cur)} per resolved).</>}
            </p>
            <table className="tbl tbl--compact">
              <thead><tr><th className="rank">#</th><th>Model</th><th className="r">Conversations</th><th className="r">Share</th><th className="r">Spend</th><th className="r">$ / resolved</th><th className="r">Resolved</th><th className="r">Avg latency</th><th className="r">vs prev</th></tr></thead>
              <tbody>
                {r.ai.models.map((m, i) => (
                  <tr key={m.model}>
                    <td className="rank mono">{String(i + 1).padStart(2, '0')}</td>
                    <td><i className="sq" style={{ background: colorFor(m.model) }} /><span className="mono dim">{splitModel(m.model).vendor}/</span>{splitModel(m.model).name}</td>
                    <td className="r mono">{num(m.conversations)}</td>
                    <td className="r mono">{pct(m.share)}</td>
                    <td className="r mono">{money(m.cost, cur)}</td>
                    <td className="r mono">{moneySmart(m.costPerResolved, cur)}</td>
                    <td className="r mono">{pct(m.resolutionRate)}</td>
                    <td className="r mono">{ms(m.avgLatencyMs)}</td>
                    <td className="r"><Delta v={m.prevConversations ? (m.conversations - m.prevConversations) / m.prevConversations : null} invert /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="sub-h mono">Assistants</p>
            <table className="tbl tbl--compact">
              <thead><tr><th>Assistant</th><th>Main model</th><th className="r">Conversations</th><th className="r">Spend</th><th className="r">Resolved</th></tr></thead>
              <tbody>
                {r.ai.assistants.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td className="mono">{a.topModel ? shortModel(a.topModel) : '—'}</td>
                    <td className="r mono">{num(a.conversations)}</td>
                    <td className="r mono">{money(a.cost, cur)}</td>
                    <td className="r mono">{pct(a.resolutionRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : <p className="empty mono">No conversational AI usage this month.</p>}
      </Section>

      <Section n="8" title="Notes">
        <ul className="doc-notes">
          <li>
            Coverage: {cov.status === 'complete' && 'the full calendar month.'}
            {cov.status === 'in_progress' && `month in progress; figures to ${utcDate(r.generatedAt)}, projection uses the average daily spend so far.`}
            {cov.status === 'partial' && `data from ${utcDate(cov.coveredFrom)} only (history backfill incomplete or monitoring started mid-month).`}
          </li>
          <li>Amounts are billed costs from Telnyx detail records, in {cur}, with days bucketed in UTC.</li>
          <li>Month-over-month changes compare with the previous calendar month&apos;s rollup when one exists.</li>
          <li>Top numbers use a Space-Saving heavy-hitters sketch: the true top spenders are always listed, and any overestimate is bounded by the &quot;± max&quot; column (shown only when non-zero).</li>
          <li>Balance figures come from polled snapshots and are absent for months before monitoring began.</li>
        </ul>
        <p className="doc-end mono">— end of statement {r.month} —</p>
      </Section>
    </article>
  );
}

export default function Reports() {
  const { month } = useParams();
  const navigate = useNavigate();
  const [listKey, setListKey] = useState(0);
  const list = useResource('/reports', listKey);
  const report = useResource(month ? `/reports/${month}` : '/reports', 0);

  // Keep polling the index while the history backfill is still running.
  useEffect(() => {
    if (!list.data?.backfill?.running) return undefined;
    const id = setTimeout(() => setListKey((x) => x + 1), 2000);
    return () => clearTimeout(id);
  }, [list.data]);

  // Default to the most recent complete month (else the latest).
  useEffect(() => {
    if (month || !list.data?.items.length) return;
    const pick = list.data.items.find((m) => m.status === 'complete') ?? list.data.items[0];
    navigate(`/dashboard/reports/${pick.month}`, { replace: true });
  }, [month, list.data, navigate]);

  const r = month && report.data?.month === month ? report.data : null;

  return (
    <>
      <HeroContent>
        <div className="hero__title">
        <div>
          <h1>Reports</h1>
          <p className="mono title-sub">One statement per calendar month · built from durable monthly rollups</p>
        </div>
        <a className="btn btn--ghost" href="/api/reports/summary.csv" download>All months · CSV</a>
      </div>
      </HeroContent>

      <div className="reports">
        <aside className="reports__aside reveal no-print" style={{ '--i': 1 }} aria-label="Months">
          <p className="aside-h mono">Statements</p>
          <MonthList data={list.data} active={month} />
        </aside>
        <div className="reports__main reveal" style={{ '--i': 2 }}>
          {list.data?.items.length > 1 && (
            <section className="trend-panel no-print" aria-label="Spend by month">
              <p className="aside-h mono">Spend by month · click a column to open it</p>
              <MonthlyTrend items={list.data.items} active={month} currency={list.data.currency} />
            </section>
          )}
          {report.error && month ? (
            <div className="doc"><p className="panel__error mono">Could not generate {month}: {report.error.message}</p></div>
          ) : r ? <Statement key={r.month} r={r} /> : <DocSkeleton month={month} />}
        </div>
      </div>
    </>
  );
}
