import { useEffect, useState } from 'react';
import { money, moneySmart, num, pct, productColor, productLabel } from '../lib/format.js';
import { SkeletonRows } from './ui.jsx';

function useMounted(delay = 60) {
  const [m, setM] = useState(false);
  useEffect(() => { const id = setTimeout(() => setM(true), delay); return () => clearTimeout(id); }, [delay]);
  return m;
}

/** One stacked bar + a ledger-style table. */
export function ProductSplit({ data, currency }) {
  const mounted = useMounted();
  if (!data) return <SkeletonRows rows={6} h={18} />;
  if (!data.items.length) return <p className="empty mono">No spend in this range.</p>;
  return (
    <div className="split">
      <div className="split__bar" aria-hidden>
        {data.items.map((it) => (
          <i key={it.product} style={{ width: mounted ? `${it.share * 100}%` : 0, background: productColor(it.product) }} />
        ))}
      </div>
      <table className="tbl tbl--compact">
        <thead>
          <tr><th>Product</th><th className="r">Spend</th><th className="r">Share</th><th className="r">Rec</th></tr>
        </thead>
        <tbody>
          {data.items.map((it) => (
            <tr key={it.product}>
              <td><i className="sq" style={{ background: productColor(it.product) }} />{productLabel(it.product)}</td>
              <td className="r mono">{money(it.cost, currency)}</td>
              <td className="r mono">{pct(it.share)}</td>
              <td className="r mono">{num(it.count)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td>Total</td><td className="r mono">{money(data.total, currency)}</td><td /><td /></tr>
        </tfoot>
      </table>
    </div>
  );
}

const DIM_LABEL = { destination: 'Number', country: 'Country', billingGroup: 'Billing group' };

/** Ranked list from the backend's heap-based top-K. */
export function TopList({ data, currency }) {
  const mounted = useMounted();
  if (!data) return <SkeletonRows rows={8} h={18} />;
  if (!data.items.length) return <p className="empty mono">Nothing billed in this range.</p>;
  const max = data.items[0].cost || 1;
  return (
    <>
      <table className="tbl tbl--compact top">
        <thead>
          <tr><th className="rank">#</th><th>{DIM_LABEL[data.by]}</th><th className="r">Spend</th><th className="r">Rec</th></tr>
        </thead>
        <tbody>
          {data.items.map((it, i) => (
            <tr key={it.key} style={{ '--d': `${i * 40}ms` }}>
              <td className="rank mono">{String(i + 1).padStart(2, '0')}</td>
              <td>
                <span className={data.by === 'destination' ? 'mono' : ''}>{it.label}</span>
                <span className="meter"><i style={{ width: mounted ? `${(it.cost / max) * 100}%` : 0 }} /></span>
              </td>
              <td className="r mono">{moneySmart(it.cost, currency)}</td>
              <td className="r mono">{num(it.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="foot-note mono">top {data.items.length} of {num(data.distinct)} · {pct(data.items.reduce((s, x) => s + x.share, 0))} of spend</p>
    </>
  );
}
