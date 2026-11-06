import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { ago } from '../lib/format.js';
import { SkeletonRows } from './ui.jsx';

const FIELDS = [
  { key: 'lowBalance', label: 'Low credit below', unit: '$' },
  { key: 'runwayDays', label: 'Runway under', unit: 'd' },
  { key: 'spikeZ', label: 'Spike z-score ≥', unit: 'σ' },
];

export default function AlertsPanel({ data, onSaved, now }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (data && !draft) setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(data.thresholds[f.key])])));
  }, [data, draft]);

  if (!data) return <SkeletonRows rows={5} h={18} />;

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      await api('/alerts/thresholds', { method: 'PUT', body: Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)])) });
      setMsg('saved');
      onSaved?.();
    } catch (err) {
      setMsg("couldn't save, try again");
    } finally {
      setSaving(false);
    }
  };

  const resolved = data.history.filter((a) => a.resolvedAt).slice(0, 3);

  return (
    <div className="alerts">
      {data.active.length === 0 ? (
        <div className="all-clear">
          <span className="all-clear__mark" aria-hidden />
          <div>
            <p className="all-clear__t">All clear</p>
            <p className="mono all-clear__s">5 rules evaluated every 15s</p>
          </div>
        </div>
      ) : (
        <ul className="alert-list">
          {data.active.map((a) => (
            <li key={a.id} className={`alert alert--${a.severity}`}>
              <span className="alert__sev mono">{a.severity === 'critical' ? 'CRIT' : 'WARN'}</span>
              <div>
                <p className="alert__t">{a.title}</p>
                <p className="alert__d mono">{a.detail}</p>
                <p className="alert__when mono">fired {ago(a.firedAt, now)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {resolved.length > 0 && (
        <ul className="alert-history mono">
          {resolved.map((a) => (
            <li key={a.id}><s>{a.title}</s> <span>resolved {ago(a.resolvedAt, now)}</span></li>
          ))}
        </ul>
      )}

      {draft && (
        <form className="thresholds" onSubmit={save}>
          <p className="thresholds__h mono">Thresholds</p>
          {FIELDS.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <span className="field">
                <input
                  type="number" min="0" step="any" inputMode="decimal"
                  value={draft[f.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
                <em>{f.unit}</em>
              </span>
            </label>
          ))}
          <div className="thresholds__foot">
            <button type="submit" className="btn btn--small" disabled={saving}>
              {saving ? <><span className="spin-square" /> Saving</> : 'Apply'}
            </button>
            {msg && <span className="mono thresholds__msg">{msg}</span>}
          </div>
        </form>
      )}
    </div>
  );
}
