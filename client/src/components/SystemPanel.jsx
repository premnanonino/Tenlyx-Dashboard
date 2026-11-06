import { num, pct, utcDate } from '../lib/format.js';
import { SkeletonRows } from './ui.jsx';

const secs = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);

function Cell({ k, v, s, tone }) {
  return (
    <div className="sys-cell">
      <p className="sys-cell__k">{k}</p>
      <p className={`sys-cell__v mono ${tone ? `tone-${tone}` : ''}`}>{v}</p>
      {s && <p className="sys-cell__s mono">{s}</p>}
    </div>
  );
}

/** Live view of the backend's internals — the system-design layer, visible. */
export default function SystemPanel({ data, now }) {
  if (!data) return <SkeletonRows rows={6} h={18} />;
  const b = data.breaker;
  const st = data.store;
  return (
    <div className="sys">
      <div className="sys-grid">
        <Cell k="Source" v="Telnyx API" s={`mode ${data.mode} · up ${secs(data.uptimeS * 1000)}`} />
        <Cell
          k="Circuit breaker"
          v={<><i className={`led led--${b.state === 'CLOSED' ? 'ok' : b.state === 'OPEN' ? 'crit' : 'warn'}`} />{b.state}</>}
          s={`fail ${pct(b.failureRatio, 0)} · trips ${b.trips} · short ${b.shortCircuited}`}
        />
        <Cell k="Response cache · LRU" v={pct(data.cache.hitRatio)} s={`${data.cache.size}/${data.cache.capacity} · evict ${num(data.cache.evictions)}`} />
        <Cell k="Single-flight" v={num(data.singleFlight.shared)} s={`coalesced of ${num(data.singleFlight.executed + data.singleFlight.shared)} calls`} />
        <Cell k="Record store" v={num(st.records)} s={`since ${st.oldestTs ? utcDate(st.oldestTs) : '—'} · v${num(st.version)}`} />
        <Cell k="Trie index" v={num(st.trieTokens)} s={`tokens · dup ${num(st.duplicates)} · late ${num(st.outOfOrder)}`} />
        <Cell k="Live stream · SSE" v={num(data.sse.clients)} s={`clients · ${num(data.sse.framesSent)} frames`} />
        <Cell k="Rate limiter" v={num(data.rateLimiter.rejected)} s={`rejected · ${num(data.rateLimiter.allowed)} allowed`} tone={data.rateLimiter.rejected ? 'warn' : undefined} />
        <Cell k="Memory" v={`${data.memoryMb.heap} MB`} s={`heap · rss ${data.memoryMb.rss} MB`} />
        <Cell k="Upstream retries" v={num(data.sync.retries)} s="backoff + full jitter" />
      </div>

      <div className="tbl-wrap">
        <table className="tbl tbl--compact jobs">
          <thead>
            <tr>
              <th>Job</th><th className="r">Every</th><th className="r">Runs</th><th className="r">Fail</th>
              <th className="r">p50</th><th className="r">p95</th><th className="r">Last ok</th><th className="r">Next</th><th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((j) => (
              <tr key={j.name}>
                <td className="mono"><i className={`led led--${j.consecutiveFailures ? 'warn' : 'ok'}`} />{j.name}</td>
                <td className="r mono">{secs(j.everyMs)}</td>
                <td className="r mono">{num(j.runs)}</td>
                <td className="r mono">{num(j.failures)}</td>
                <td className="r mono">{j.p50Ms} ms</td>
                <td className="r mono">{j.p95Ms} ms</td>
                <td className="r mono">{j.lastOkAt ? `${secs(now - j.lastOkAt)} ago` : '—'}</td>
                <td className="r mono">{j.nextRunAt ? `in ${secs(Math.max(0, j.nextRunAt - now))}` : '—'}</td>
                <td className="mono dim ellipsis">{j.lastError || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
