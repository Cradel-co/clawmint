import { useEffect, useState } from 'react';
import { metrics as api } from '../../api/admin';
import styles from './AdminPanel.module.css';

/**
 * MetricsDashboard — lee /api/metrics/json cada N segundos y muestra
 * counters + mini-histogramas. Sin recharts por ahora (dep opcional);
 * usamos SVG + CSS para un dashboard liviano.
 */
export default function MetricsDashboard({ accessToken }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshSec, setRefreshSec] = useState(10);

  useEffect(() => {
    let timer = null;
    const tick = async () => {
      try { setData(await api.json(accessToken)); setError(null); }
      catch (e) { setError(e.message); }
    };
    tick();
    if (refreshSec > 0) timer = setInterval(tick, refreshSec * 1000);
    return () => { if (timer) clearInterval(timer); };
  }, [accessToken, refreshSec]);

  const counters  = data?.counters  || data?.counter  || {};
  const gauges    = data?.gauges    || data?.gauge    || {};
  const histograms = data?.histograms || data?.histogram || {};

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Métricas</h1>
          <p className={styles.subtitle}>
            Live metrics del server (auto-refresh {refreshSec}s).
          </p>
        </div>
        <div className={styles.actions}>
          <select className={styles.select} style={{ width: 120 }} value={refreshSec} onChange={e => setRefreshSec(Number(e.target.value))}>
            <option value={5}>5s</option>
            <option value={10}>10s</option>
            <option value={30}>30s</option>
            <option value={60}>60s</option>
            <option value={0}>manual</option>
          </select>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {!data ? <div className={styles.empty}>Cargando métricas…</div> : (
        <>
          <Section title="Counters">
            {Object.keys(counters).length === 0 ? (
              <div className={styles.empty}>Sin counters registrados.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
                {Object.entries(counters).map(([name, value]) => (
                  <CounterCard key={name} name={name} value={value} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Gauges">
            {Object.keys(gauges).length === 0 ? (
              <div className={styles.empty}>Sin gauges registrados.</div>
            ) : (
              <table className={styles.table}>
                <thead><tr><th>Métrica</th><th>Valor</th></tr></thead>
                <tbody>
                  {Object.entries(gauges).map(([name, value]) => (
                    <tr key={name}>
                      <td className={styles.mono}>{name}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{formatNum(value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Histograms">
            {Object.keys(histograms).length === 0 ? (
              <div className={styles.empty}>Sin histogramas.</div>
            ) : (
              <table className={styles.table}>
                <thead><tr><th>Métrica</th><th>count</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr></thead>
                <tbody>
                  {Object.entries(histograms).map(([name, h]) => (
                    <tr key={name}>
                      <td className={styles.mono}>{name}</td>
                      <td>{h.count ?? h.n ?? '—'}</td>
                      <td>{formatNum(h.p50)}</td>
                      <td>{formatNum(h.p95)}</td>
                      <td>{formatNum(h.p99)}</td>
                      <td>{formatNum(h.max)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Raw">
            <details>
              <summary style={{ cursor: 'pointer', color: 'var(--oc2-text-weak)' }}>Ver JSON crudo</summary>
              <pre className={styles.mono} style={{ marginTop: 8, maxHeight: 300, overflow: 'auto', padding: 12, background: 'var(--oc2-surface-base)', borderRadius: 6 }}>
                {JSON.stringify(data, null, 2)}
              </pre>
            </details>
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className={styles.card}>
      <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>{title}</h2>
      {children}
    </section>
  );
}

function CounterCard({ name, value }) {
  return (
    <div style={{
      padding: 12,
      background: 'var(--oc2-surface-base)',
      border: '1px solid var(--oc2-border-weaker)',
      borderRadius: 6,
    }}>
      <div className={styles.mono} style={{ fontSize: 11, color: 'var(--oc2-text-weak)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--oc2-text-strong)', fontVariantNumeric: 'tabular-nums' }}>
        {formatNum(value)}
      </div>
    </div>
  );
}

function formatNum(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toFixed(2);
}
