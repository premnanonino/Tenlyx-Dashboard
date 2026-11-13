import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { ago, money } from '../lib/format.js';
import { SkeletonRows } from './ui.jsx';

/* Everything about alerts lives in this card: status, the rules, history and
   thresholds. Nothing else on the dashboard reacts to alerts. */

/** The backend's five rules (see server/src/services/alertEngine.js). */
const RULES = [
  { key: 'low_balance', label: 'Available credit', severity: 'critical' },
  { key: 'runway', label: 'Credit runway', severity: 'warning' },
  { key: 'spend_spike', label: 'Hourly spend spike', severity: 'warning' },
  { key: 'upstream_down', label: 'Telnyx API reachable', severity: 'critical' },
  { key: 'stale_data', label: 'Usage data fresh', severity: 'warning' },
];

const FIELDS = [
  { key: 'lowBalance', label: 'Low credit below', unit: '$', now: (c) => (c?.lowBalance != null ? money(c.lowBalance, c.currency, 0) : null) },
  { key: 'runwayDays', label: 'Runway under', unit: 'd', now: (c) => (c?.runwayDays != null ? `${c.runwayDays.toFixed(1)} d` : null) },
  { key: 'spikeZ', label: 'Spike z-score ≥', unit: 'σ', now: () => null },
];

const SEV = { critical: 'CRIT', warning: 'WARN' };

/** "4m", "2h 10m", "3d 4h": how long something lasted. */
function span(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

/** Small count shown in the card header: "2 active" or "OK". */
export function AlertsBadge({ data }) {
  if (!data) return null;
  const n = data.active.length;
  const crit = data.active.some((a) => a.severity === 'critical');
  return (
    <span className={`al-badge mono ${n ? (crit ? 'al-badge--crit' : 'al-badge--warn') : 'al-badge--ok'}`}>
      {n ? `${n} active` : 'OK'}
    </span>
  );
}

const toDraft = (t) => Object.fromEntries(FIELDS.map((f) => [f.key, String(t[f.key])]));

export default function AlertsPanel({ data, onSaved, now, current }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (data && !draft) setDraft(toDraft(data.thresholds));
  }, [data, draft]);
  useEffect(() => {
    if (!msg) return undefined;
    const id = setTimeout(() => setMsg(null), 2500);
    return () => clearTimeout(id);
  }, [msg]);

  if (!data) return <SkeletonRows rows={8} h={18} />;

  const saved = toDraft(data.thresholds);
  const dirty = draft && FIELDS.some((f) => draft[f.key] !== saved[f.key]);
  const invalid = draft && FIELDS.some((f) => draft[f.key] === '' || !(Number(draft[f.key]) >= 0));

  const save = async (e) => {
    e.preventDefault();
    if (!dirty || invalid) return;
    setSaving(true); setMsg(null);
    try {
      await api('/alerts/thresholds', { method: 'PUT', body: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)])) });
      setMsg({ ok: true, text: 'saved · rules re-checked' });
      onSaved?.();
    } catch {
      setMsg({ ok: false, text: "couldn't save, try again" });
    } finally {
      setSaving(false);
    }
  };

  const active = [...data.active].sort((a, b) => (a.severity === b.severity ? b.firedAt - a.firedAt : a.severity === 'critical' ? -1 : 1));
  const firing = new Map(data.active.map((a) => [a.key, a]));
  const resolved = data.history.filter((a) => a.resolvedAt);
  const shown = showAll ? resolved.slice(0, 15) : resolved.slice(0, 3);
  const crit = active.filter((a) => a.severity === 'critical').length;

  return (
    <div className="alerts">
      {/* Status */}
      {active.length === 0 ? (
        <div className="all-clear">
          <span className="all-clear__mark" aria-hidden />
          <div>
            <p className="all-clear__t">All clear</p>
            <p className="mono all-clear__s">{RULES.length} rules checked every 15s</p>
          </div>
        </div>
      ) : (
        <p className={`al-status mono ${crit ? 'al-status--crit' : ''}`} role="status">
          {active.length} alert{active.length > 1 ? 's' : ''} firing{crit ? ` · ${crit} critical` : ''}
        </p>
      )}

      {/* Active alerts */}
      {active.length > 0 && (
        <ul className="alert-list">
          {active.map((a) => (
            <li key={a.id} className={`alert alert--${a.severity}`}>
              <span className="alert__sev mono">{SEV[a.severity] ?? 'WARN'}</span>
              <div>
                <p className="alert__t">{a.title}</p>
                <p className="alert__d mono">{a.detail}</p>
                <p className="alert__when mono">firing for {span(now - a.firedAt)} · since {ago(a.firedAt, now)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Every rule, live */}
      <section className="al-sec">
        <p className="al-h mono">Rules</p>
        <ul className="al-rules">
          {RULES.map((r) => {
            const on = firing.get(r.key);
            const state = on ? (on.severity === 'critical' ? 'crit' : 'warn') : 'ok';
            return (
              <li key={r.key} className={`al-rule al-rule--${state}`}>
                <i className="al-led" aria-hidden />
                <span className="al-rule__l">{r.label}</span>
                <span className="al-rule__s mono">{on ? SEV[on.severity] : 'ok'}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* History */}
      {resolved.length > 0 && (
        <section className="al-sec">
          <p className="al-h mono">
            Recently resolved
            {resolved.length > 3 && (
              <button type="button" className="al-more mono" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'show less' : `show ${Math.min(15, resolved.length)}`}
              </button>
            )}
          </p>
          <ul className="alert-history mono">
            {shown.map((a) => (
              <li key={a.id}>
                <i className={`al-dot al-dot--${a.severity}`} aria-hidden />
                <span className="al-hist__t">{a.title}</span>
                <span className="al-hist__m">lasted {span(a.resolvedAt - a.firedAt)} · {ago(a.resolvedAt, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Thresholds */}
      {draft && (
        <form className="thresholds" onSubmit={save}>
          <p className="al-h mono">Thresholds</p>
          {FIELDS.map((f) => {
            const nowVal = f.now(current);
            const changed = draft[f.key] !== saved[f.key];
            return (
              <label key={f.key} className={changed ? 'is-changed' : ''}>
                <span className="thr__l">
                  {f.label}
                  {nowVal && <span className="thr__now mono">now {nowVal}</span>}
                </span>
                <span className="field">
                  <input
                    type="number" min="0" step="any" inputMode="decimal"
                    value={draft[f.key]}
                    aria-invalid={draft[f.key] === '' || !(Number(draft[f.key]) >= 0)}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                  <em>{f.unit}</em>
                </span>
              </label>
            );
          })}
          <div className="thresholds__foot">
            <button type="submit" className="btn btn--small" disabled={saving || !dirty || invalid}>
              {saving ? <><span className="spin-square" /> Saving</> : 'Apply'}
            </button>
            {dirty && !saving && (
              <button type="button" className="btn btn--ghost btn--small" onClick={() => setDraft(saved)}>Reset</button>
            )}
            {msg && <span className={`mono thresholds__msg ${msg.ok ? '' : 'is-err'}`} role="status">{msg.text}</span>}
            {invalid && !msg && <span className="mono thresholds__msg is-err">enter a number ≥ 0</span>}
          </div>
        </form>
      )}
    </div>
  );
}
