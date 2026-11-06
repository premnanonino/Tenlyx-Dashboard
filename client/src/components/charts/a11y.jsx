import { useCallback, useState } from 'react';

/**
 * Keyboard model shared by every chart: focus the chart (Tab), then
 * ←/→ (or ↑/↓) step through data points, Home/End jump, Esc clears.
 * The active point drives the same tooltip a mouse hover would, and its
 * description is announced through a polite live region.
 */
export function useChartKeys(count, { initial = null } = {}) {
  const [active, setActive] = useState(initial);
  const onKeyDown = useCallback((e) => {
    if (!count) return;
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (e.key in keys) {
      e.preventDefault();
      setActive((i) => (i === null ? (keys[e.key] > 0 ? 0 : count - 1) : Math.min(count - 1, Math.max(0, i + keys[e.key]))));
    } else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(count - 1); }
    else if (e.key === 'Escape') setActive(null);
  }, [count]);
  return {
    active,
    setActive,
    focusProps: { tabIndex: 0, onKeyDown, onBlur: () => setActive(null), className: 'chart-focus' },
  };
}

export function LiveRegion({ text }) {
  return <p className="sr-only" aria-live="polite" aria-atomic="true">{text || ''}</p>;
}

/** Visually hidden table with the chart's numbers, for screen readers. */
export function DataTable({ caption, columns, rows }) {
  return (
    <div className="sr-only">
    <table>
      <caption>{caption}</caption>
      <thead><tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => (j === 0 ? <th key={j} scope="row">{v}</th> : <td key={j}>{v}</td>))}</tr>)}</tbody>
    </table>
    </div>
  );
}

export const KEY_HINT = 'Use arrow keys to move between points.';
