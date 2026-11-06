import { useEffect, useState } from 'react';
import { useResource } from '../lib/api.js';
import { useInView, useNow } from '../lib/hooks.js';
import { ago, money, num, productColor, productLabel, signedPct, utcDate } from '../lib/format.js';
import { Figure, Panel, SkeletonRows, Tabs } from '../components/ui.jsx';
import RangePicker, { rangeLabel, rangeQuery } from '../components/RangePicker.jsx';
import Donut from '../components/charts/Donut.jsx';
import Heatmap from '../components/charts/Heatmap.jsx';
import PaceChart from '../components/charts/PaceChart.jsx';
import SpendChart from '../components/SpendChart.jsx';
import { TopList } from '../components/Breakdowns.jsx';
import BalanceChart from '../components/BalanceChart.jsx';
import AlertsPanel from '../components/AlertsPanel.jsx';
import Ledger from '../components/Ledger.jsx';
import SystemPanel from '../components/SystemPanel.jsx';
import Ticker from '../components/Ticker.jsx';
import { HeroContent, useLive } from '../layout/AppLayout.jsx';

const DIMS = [
  { value: 'destination', label: 'Number' },
  { value: 'country', label: 'Country' },
  { value: 'billingGroup', label: 'Group' },
];

export default function Dashboard() {
  const now = useNow(1000);
  const { tick: k, tape, alerts } = useLive();
  const [range, setRange] = useState({ range: '24h' });
  const [dim, setDim] = useState('destination');
  const rq = rangeQuery(range);
  // A heatmap needs several days to mean anything.
  const heatQ = range.range === '24h' ? 'range=7d' : rq;
  const [sysTick, setSysTick] = useState(0);

  // Above the fold: fetched immediately.
  const overview = useResource('/overview', k);
  const series = useResource(`/spend/series?${rq}`, k);
  const split = useResource(`/spend/products?${rq}`, k);

  // Below the fold: each panel fetches only once it scrolls near the viewport.
  const [paceRef, paceSeen] = useInView();
  const [heatRef, heatSeen] = useInView();
  const [topRef, topSeen] = useInView();
  const [balRef, balSeen] = useInView();
  const [ledgerRef, ledgerSeen] = useInView();
  const [sysRef, sysSeen, sysVisible] = useInView('100px');
  const pace = useResource('/spend/pace', k, { enabled: paceSeen });
  const heat = useResource(`/spend/heatmap?${heatQ}`, k, { enabled: heatSeen });
  const top = useResource(`/top?by=${dim}&k=8&${rq}`, k, { enabled: topSeen });
  const balance = useResource(`/balance/history?${rq}`, k, { enabled: balSeen });
  const system = useResource('/system', sysTick, { enabled: sysSeen });

  // Internals refresh on their own 4s clock, but only while on screen.
  useEffect(() => {
    if (!sysVisible) return undefined;
    const id = setInterval(() => setSysTick((x) => x + 1), 4000);
    return () => clearInterval(id);
  }, [sysVisible]);

  const o = overview.data;
  const cur = o?.currency || 'USD';
  const loadingFig = overview.initial;
  const activeAlerts = alerts.data?.active.length || 0;
  const monthEnd = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 0));

  return (
    <>
      <HeroContent>
        <div className="hero__title">
        <div>
          <h1>Billing overview</h1>
          <p className="mono title-sub">
          {o ? (
            <>
              {cur} · times in UTC · balance read {ago(o.balanceAt, now)}
              {activeAlerts > 0 && <> · <a href="#alerts" className="alert-link">{activeAlerts} active alert{activeAlerts > 1 ? 's' : ''}</a></>}
            </>
          ) : 'loading account…'}
          </p>
        </div>
        <div className="title-tools">
          {(series.switching || split.switching) && <span className="spin-square" aria-label="Loading range" />}
          <RangePicker value={range} onChange={setRange} />
        </div>
      </div>
      </HeroContent>
      <HeroContent><Ticker items={tape} /></HeroContent>

      <section className="figures reveal" style={{ '--i': 1 }} aria-label="Key figures">
        <Figure
          n="A" label="Balance" loading={loadingFig} value={o?.balance} format={(v) => money(v, cur)}
          sub={o?.balanceDelta1h != null ? `${o.balanceDelta1h >= 0 ? '+' : '−'}${money(Math.abs(o.balanceDelta1h), cur)} last hour` : `pending ${money(o?.pending, cur)}`}
        />
        <Figure
          n="B" label="Available credit" loading={loadingFig} value={o?.availableCredit} format={(v) => money(v, cur)}
          sub={`limit ${money(o?.creditLimit, cur, 0)} · pending ${money(o?.pending, cur)}`}
          tone={o && o.availableCredit < (alerts.data?.thresholds.lowBalance ?? 0) ? 'crit' : undefined}
        />
        <Figure
          n="C" label="Spend · last 24h" loading={loadingFig} value={o?.spend24h} format={(v) => money(v, cur)}
          sub={`${signedPct(o?.spend24hChange)} vs prior 24h · ${num(o?.records24h)} rec`}
          tone={o?.spend24hChange > 0.25 ? 'up' : o?.spend24hChange < 0 ? 'down' : undefined}
        />
        <Figure
          n="D" label="Runway" loading={loadingFig} value={o?.runwayDays} format={(v) => `${v.toFixed(1)} days`}
          sub={`at ${money(o?.avgDaily, cur)}/day (7d avg)`}
          tone={o && o.runwayDays !== null && o.runwayDays < (alerts.data?.thresholds.runwayDays ?? 0) ? 'crit' : undefined}
        />
        <Figure
          n="E" label="Month to date" loading={loadingFig} value={o?.spendMTD} format={(v) => money(v, cur)}
          sub={`projected ${money(o?.projectedMonth, cur, 0)} by ${utcDate(monthEnd.getTime())}`}
        />
      </section>

      <div className="dash-grid">
        <Panel n={1} i={2} title={`Spend over time · ${rangeLabel(range)}`} className="span-8" busy={series.switching} error={series.error}>
          <SpendChart data={series.data} currency={cur} />
        </Panel>

        <Panel n={2} i={3} title="Where it goes" className="span-4" busy={split.switching} error={split.error}>
          {split.data ? (
            split.data.items.length ? (
              <Donut items={split.data.items.map((x) => ({ key: x.product, value: x.cost }))} colorFor={productColor}
                labelFor={productLabel} format={(v) => money(v, cur)} caption={`Spend by product, ${rangeLabel(range)}`} />
            ) : <p className="empty mono">No spend in this range.</p>
          ) : <SkeletonRows rows={8} h={18} />}
        </Panel>

        <Panel n={3} i={4} title="Month pace" className="span-7" error={pace.error} lazyRef={paceRef}>
          <PaceChart data={pace.data} />
        </Panel>

        <Panel n={4} i={5} title={`When you spend · ${range.range === '24h' ? '7D' : rangeLabel(range)}`} className="span-5" busy={heat.switching} error={heat.error} lazyRef={heatRef}>
          {heat.data ? <Heatmap data={heat.data} currency={cur} /> : <SkeletonRows rows={7} h={18} />}
          {range.range === '24h' && <p className="foot-note mono">uses the last 7 days: one day is too little for a weekly pattern</p>}
        </Panel>

        <Panel n={5} i={6} title={`Top spend · ${rangeLabel(range)}`} className="span-5" busy={top.switching} error={top.error} lazyRef={topRef}
          aside={<Tabs value={dim} onChange={setDim} options={DIMS} label="Top dimension" />}>
          <TopList data={top.data} currency={cur} />
        </Panel>

        <Panel n={6} i={7} title="Balance" className="span-4" busy={balance.switching} error={balance.error} lazyRef={balRef}>
          <BalanceChart data={balance.data} currency={cur} />
        </Panel>

        <Panel n={7} i={8} title="Alerts" className="span-3" error={alerts.error}>
          <div id="alerts" />
          <AlertsPanel data={alerts.data} now={now} onSaved={alerts.reload} />
        </Panel>

        <Panel n={8} i={9} title="Ledger" className="span-12" lazyRef={ledgerRef}>
          {ledgerSeen ? <Ledger tick={k} currency={cur} range={range} /> : <SkeletonRows rows={10} h={20} />}
        </Panel>

        <Panel n={9} i={10} title="Backend internals" className="span-12" error={system.error} lazyRef={sysRef}
          aside={<span className="mono dim refresh-note">refresh 4s</span>}>
          <SystemPanel data={system.data} now={now} />
        </Panel>
      </div>
    </>
  );
}
