import { useEffect, useMemo, useState } from 'react';
import { useResource } from '../lib/api.js';
import { money, moneySmart, ms, num, pct, shortModel, splitModel, modelColors, duration, compact } from '../lib/format.js';
import { Figure, Panel, SkeletonRows } from '../components/ui.jsx';
import RangePicker, { rangeLabel, rangeQuery } from '../components/RangePicker.jsx';
import Donut from '../components/charts/Donut.jsx';
import Radar from '../components/charts/Radar.jsx';
import Histogram from '../components/charts/Histogram.jsx';
import ModelBars from '../components/ai/ModelBars.jsx';
import ModelScatter from '../components/ai/ModelScatter.jsx';
import Leaderboard from '../components/ai/Leaderboard.jsx';
import { HeroContent, useLive } from '../layout/AppLayout.jsx';
import '../styles/ai.css';

/** 50 hard-edged blocks that fill to the model's share, one after another. */
function ShareBlocks({ value, color }) {
  const [on, setOn] = useState(false);
  useEffect(() => { const id = setTimeout(() => setOn(true), 120); return () => clearTimeout(id); }, []);
  const filled = Math.round(value * 50);
  return (
    <div className="blocks" aria-hidden>
      {Array.from({ length: 50 }, (_, i) => (
        <i key={i} style={{ background: on && i < filled ? color : undefined, transitionDelay: `${i * 14}ms` }} />
      ))}
    </div>
  );
}

function MostUsed({ data, colorFor, currency }) {
  if (!data) return <SkeletonRows rows={8} h={20} />;
  const top = data.models[0];
  if (!top) return <p className="empty mono">No AI conversations in this range.</p>;
  const { vendor, name } = splitModel(top.model);
  const lead = data.models[1] ? top.conversations / data.models[1].conversations : null;
  return (
    <div className="mu">
      <p className="mu__rank mono"><span>#1</span> by conversations{lead ? ` · ${lead.toFixed(1)}× the runner-up` : ''}</p>
      <p className="mu__vendor mono">{vendor}{vendor && ' /'}</p>
      <p className="mu__name" title={top.model}>{name}</p>
      <div className="mu__share">
        <span className="mono">{pct(top.share)}</span>
        <span>of {num(data.totals.conversations)} conversations</span>
      </div>
      <ShareBlocks value={top.share} color={colorFor(top.model)} />
      <dl className="mu__stats">
        <div><dt>Conversations</dt><dd className="mono">{num(top.conversations)}</dd></div>
        <div><dt>Spend</dt><dd className="mono">{money(top.cost, currency)}</dd></div>
        <div><dt>Resolved</dt><dd className="mono">{pct(top.resolutionRate)}</dd></div>
        <div><dt>p50 latency</dt><dd className="mono">{ms(top.p50LatencyMs)}</dd></div>
      </dl>
      <ol className="mu__runners">
        {data.models.slice(1, 5).map((m, i) => (
          <li key={m.model}>
            <span className="mono dim">#{i + 2}</span>
            <i className="sq" style={{ background: colorFor(m.model) }} />
            <span className="mu__rn">{shortModel(m.model)}</span>
            <span className="meter"><i style={{ width: `${(m.share / top.share) * 100}%`, background: colorFor(m.model) }} /></span>
            <span className="mono">{pct(m.share)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const AWARDS = [
  { key: 'mostUsed', label: 'Most used', fmt: (v) => `${pct(v)} of conversations` },
  { key: 'bestResolution', label: 'Best resolution', fmt: (v) => `${pct(v)} resolved` },
  { key: 'bestValue', label: 'Best value', fmt: (v, c) => `${moneySmart(v, c)} per resolved` },
  { key: 'fastest', label: 'Fastest', fmt: (v) => `${ms(v)} p50` },
];

function Scorecard({ data, colorFor, currency }) {
  if (!data) return <SkeletonRows rows={9} h={20} />;
  const sc = data.scorecard;
  return (
    <>
      <div className="awards">
        {AWARDS.map((a, i) => {
          const w = sc[a.key];
          return (
            <div key={a.key} className="award" style={{ '--d': `${i * 90}ms` }}>
              <p className="award__k">{a.label}</p>
              {w ? (
                <>
                  <p className="award__m"><i className="sq" style={{ background: colorFor(w.model) }} />{shortModel(w.model)}</p>
                  <p className="award__v mono">{a.fmt(w.v, currency)}</p>
                </>
              ) : <p className="award__v mono dim">not enough data</p>}
            </div>
          );
        })}
      </div>
      <ModelScatter models={data.models} colorFor={colorFor} currency={currency} />
      <p className="foot-note mono">
        No single &quot;best&quot;: each award is one axis. Models need ≥{sc.minSample} conversations to qualify.
        &quot;Value&quot; = spend ÷ resolved conversations.
      </p>
    </>
  );
}

const OUTCOMES = [
  { key: 'resolved', label: 'Resolved by AI', color: 'var(--ok)' },
  { key: 'transferred', label: 'Transferred to human', color: 'var(--warn)' },
  { key: 'abandoned', label: 'Abandoned', color: 'var(--crit)' },
  { key: 'unknown', label: 'Unknown', color: 'var(--paper-3)' },
];

const OUTCOME_COLOR = { resolved: 'var(--ok)', transferred: 'var(--warn)', abandoned: 'var(--crit)', unknown: 'var(--paper-3)' };
const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.key, o.label]));
const CHANNEL_COLOR = { voice: 'var(--ink)', chat: 'var(--accent)' };

function Outcomes({ data }) {
  if (!data) return <SkeletonRows rows={6} h={18} />;
  const outs = OUTCOMES.filter((o) => data.outcomes[o.key] > 0).map((o) => ({ key: o.key, value: data.outcomes[o.key] }));
  const ch = Object.entries(data.channels).sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, value }));
  return (
    <div className="outcomes">
      <Donut items={outs} colorFor={(k) => OUTCOME_COLOR[k]} labelFor={(k) => OUTCOME_LABEL[k]} format={(v) => num(v)}
        caption="Conversation outcomes" centerLabel="Conversations" size={172} />
      <p className="sub-h mono">Channel</p>
      <Donut items={ch} variant="pie" colorFor={(k) => CHANNEL_COLOR[k] || 'var(--m-2)'} labelFor={(k) => k[0].toUpperCase() + k.slice(1)}
        format={(v) => num(v)} caption="Conversations by channel" size={120} />
      <dl className="mini-stats">
        <div><dt>Avg length</dt><dd className="mono">{duration(data.totals.avgDurationSec)}</dd></div>
        <div><dt>Avg turns</dt><dd className="mono">{data.totals.avgTurns?.toFixed(1) ?? '—'}</dd></div>
        <div><dt>Tokens</dt><dd className="mono">{compact(data.totals.tokens)}</dd></div>
      </dl>
    </div>
  );
}

function Assistants({ data, colorFor, currency }) {
  if (!data) return <SkeletonRows rows={5} h={20} />;
  if (!data.assistants.length) return <p className="empty mono">No assistants active in this range.</p>;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Assistant</th><th>Models used</th><th className="r">Conversations</th><th className="r">Spend</th>
            <th className="r">$ / conv</th><th className="r">Resolved</th><th className="r">Avg latency</th>
          </tr>
        </thead>
        <tbody>
          {data.assistants.map((a) => (
            <tr key={a.id}>
              <td><b>{a.name}</b><span className="mono dim asst-id">{a.id}</span></td>
              <td>
                <div className="chips">
                  {a.models.map((m) => (
                    <span key={m.model} className="mchip mono" title={m.model}>
                      <i style={{ background: colorFor(m.model) }} />{shortModel(m.model)} <em>{pct(m.share, 0)}</em>
                    </span>
                  ))}
                </div>
              </td>
              <td className="r mono">{num(a.conversations)}</td>
              <td className="r mono">{money(a.cost, currency)}</td>
              <td className="r mono">{moneySmart(a.costPerConversation, currency)}</td>
              <td className="r mono">{pct(a.resolutionRate)}</td>
              <td className="r mono">{ms(a.avgLatencyMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AiPage() {
  const { tick } = useLive();
  const [range, setRange] = useState({ range: '7d' });
  const ai = useResource(`/ai/overview?${rangeQuery(range)}`, tick);
  const ov = useResource('/overview', tick);
  const d = ai.data;
  const t = d?.totals;
  const cur = ov.data?.currency || 'USD';
  const colorFor = useMemo(() => modelColors(d?.models.map((m) => m.model) ?? []), [d]);

  return (
    <>
      <HeroContent>
        <div className="hero__title">
        <div>
          <h1>Conversational AI</h1>
          <p className="mono title-sub">
            {t ? `${t.models} models · ${t.assistants} assistants · ${num(t.conversations)} conversations` : 'loading conversations…'}
          </p>
        </div>
        <div className="title-tools">
          {ai.switching && <span className="spin-square" aria-label="Loading" />}
          <RangePicker value={range} onChange={setRange} />
        </div>
      </div>
      </HeroContent>

      <section className={`figures reveal ${ai.switching ? 'is-busy' : ''}`} style={{ '--i': 1 }} aria-label="AI key figures">
        <Figure n="A" label="Conversations" loading={ai.initial} value={t?.conversations} format={(v) => num(Math.round(v))}
          sub={t ? `${num(d.outcomes.resolved)} resolved by AI` : ''} />
        <Figure n="B" label="AI spend" loading={ai.initial} value={t?.cost} format={(v) => money(v, cur)}
          sub={t ? `${compact(t.tokens)} tokens · ${num(Math.round(t.minutes))} min` : ''} />
        <Figure n="C" label="Cost / conversation" loading={ai.initial} value={t?.costPerConversation} format={(v) => moneySmart(v, cur)}
          sub={t ? `${moneySmart(t.costPerResolved, cur)} per resolved` : ''} />
        <Figure n="D" label="Resolution rate" loading={ai.initial} value={t?.resolutionRate} format={(v) => pct(v)}
          sub={t ? `${pct(t.transferRate)} transferred · ${pct(t.abandonRate)} abandoned` : ''}
          tone={t?.resolutionRate !== null && t?.resolutionRate < 0.7 ? 'warn' : undefined} />
        <Figure n="E" label="Median latency" loading={ai.initial} value={t?.p50LatencyMs} format={(v) => ms(v)}
          sub={t ? `mean ${ms(t.avgLatencyMs)}` : ''} />
      </section>

      <div className="dash-grid">
        <Panel n={1} i={2} title="Most used model" className="span-5" busy={ai.switching} error={ai.error}>
          <MostUsed data={d} colorFor={colorFor} currency={cur} />
        </Panel>
        <Panel n={2} i={3} title="Which model is better" className="span-7" busy={ai.switching}>
          <Scorecard data={d} colorFor={colorFor} currency={cur} />
        </Panel>
        <Panel n={3} i={4} title="Model profile" className="span-5" busy={ai.switching}>
          {d ? (d.models.length ? <Radar models={d.models} colorFor={colorFor} /> : <p className="empty mono">No models in range.</p>) : <SkeletonRows rows={8} h={22} />}
        </Panel>
        <Panel n={4} i={5} title="Response latency" className="span-7" busy={ai.switching}>
          {d ? <Histogram key={rangeLabel(range)} latency={d.latency} colorFor={colorFor} /> : <SkeletonRows rows={8} h={22} />}
        </Panel>
        <Panel n={5} i={6} title={`Conversations by model · ${rangeLabel(range)}`} className="span-8" busy={ai.switching}>
          {d ? <ModelBars series={d.series} colorFor={colorFor} /> : <SkeletonRows rows={8} h={22} />}
        </Panel>
        <Panel n={6} i={7} title="Outcomes & channel" className="span-4" busy={ai.switching}>
          <Outcomes data={d} />
        </Panel>
        <Panel n={7} i={8} title="Model leaderboard" className="span-12" busy={ai.switching}>
          {d ? <Leaderboard models={d.models} colorFor={colorFor} currency={cur} best={d.scorecard} /> : <SkeletonRows rows={6} h={22} />}
          {d && <p className="foot-note mono">click a column to sort · highlighted cells are award winners · rank = conversation volume</p>}
        </Panel>
        <Panel n={8} i={9} title="Assistants" className="span-12" busy={ai.switching}>
          <Assistants data={d} colorFor={colorFor} currency={cur} />
        </Panel>
      </div>
    </>
  );
}
