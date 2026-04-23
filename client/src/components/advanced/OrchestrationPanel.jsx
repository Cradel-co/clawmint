import { useEffect, useState } from 'react';
import { orchestration as api } from '../../api/advanced';
import styles from '../admin/AdminPanel.module.css';

/**
 * OrchestrationPanel (Fase E.5) — workflows multi-agente activos con
 * árbol de delegaciones y cancelación en vivo.
 */
export default function OrchestrationPanel({ accessToken }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [refreshSec, setRefreshSec] = useState(5);

  const load = async () => {
    setError(null);
    try { setItems(await api.workflows(accessToken)); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => {
    load();
    if (refreshSec > 0) {
      const t = setInterval(load, refreshSec * 1000);
      return () => clearInterval(t);
    }
  }, [accessToken, refreshSec]);

  const cancel = async (id) => {
    if (!confirm(`¿Cancelar workflow ${id}? Las tasks en curso quedan como 'cancelled'.`)) return;
    setBusy(id);
    try { await api.cancel(accessToken, id); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Orchestration</h1>
          <p className={styles.subtitle}>
            Workflows multi-agente activos (coordinator → subagentes tipo explore/plan/code/researcher).
          </p>
        </div>
        <div className={styles.actions}>
          <select className={styles.select} style={{ width: 120 }} value={refreshSec} onChange={e => setRefreshSec(Number(e.target.value))}>
            <option value={2}>2s</option>
            <option value={5}>5s</option>
            <option value={10}>10s</option>
            <option value={30}>30s</option>
            <option value={0}>manual</option>
          </select>
          <button className={styles.btn} onClick={load}>Refresh</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {items === null ? <div className={styles.empty}>Cargando…</div> : items.length === 0 ? (
        <div className={styles.card}><div className={styles.empty}>Sin workflows activos.</div></div>
      ) : items.map(wf => (
        <section key={wf.id} className={styles.card}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <h2 className={styles.mono} style={{ margin: 0, fontSize: 14, color: 'var(--oc2-text-strong)' }}>{wf.id}</h2>
            <span className={`${styles.tag} ${statusTag(wf.status)}`}>{wf.status}</span>
            <span className={styles.tag}>coordinator: {wf.coordinator}</span>
            <span className={styles.tag}>chat: <span className={styles.mono}>{wf.chatId}</span></span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--oc2-text-weak)' }}>
              {wf.delegationCount} delegaciones · {formatAgo(wf.createdAt)}
            </span>
            {wf.status === 'active' && (
              <button className={`${styles.btn} ${styles.btnDanger}`} disabled={busy === wf.id} onClick={() => cancel(wf.id)}>
                {busy === wf.id ? '…' : 'Cancelar'}
              </button>
            )}
          </header>

          {wf.tasks.length === 0 ? (
            <div className={styles.empty}>Sin delegaciones aún.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Task ID</th>
                  <th>Agent</th>
                  <th>Tipo</th>
                  <th>Status</th>
                  <th>Duración</th>
                  <th>Resultado preview</th>
                </tr>
              </thead>
              <tbody>
                {wf.tasks.map(t => (
                  <tr key={t.id}>
                    <td className={styles.mono}>{t.id}</td>
                    <td>{t.agent}</td>
                    <td>{t.subagentType ? <span className={styles.tag}>{t.subagentType}</span> : <span style={{ opacity: 0.5 }}>—</span>}</td>
                    <td><span className={`${styles.tag} ${statusTag(t.status)}`}>{t.status}</span></td>
                    <td className={styles.mono}>{formatDuration(t.startedAt, t.completedAt)}</td>
                    <td style={{ maxWidth: 400, fontSize: 11, color: 'var(--oc2-text-weak)', fontFamily: 'var(--font-mono)' }}>
                      {t.resultPreview || <span style={{ opacity: 0.5 }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}

function statusTag(s) {
  if (s === 'active' || s === 'running') return styles.tagInfo;
  if (s === 'done' || s === 'completed') return styles.tagSuccess;
  if (s === 'failed' || s === 'error')    return styles.tagError;
  if (s === 'cancelled')                  return styles.tagWarning;
  return '';
}

function formatAgo(ms) {
  if (!ms) return '—';
  const age = Date.now() - ms;
  if (age < 60_000) return `${Math.round(age / 1000)}s atrás`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m atrás`;
  return `${Math.round(age / 3_600_000)}h atrás`;
}

function formatDuration(start, end) {
  if (!start) return '—';
  const dur = (end || Date.now()) - start;
  if (dur < 1000) return `${dur}ms`;
  if (dur < 60_000) return `${(dur / 1000).toFixed(1)}s`;
  return `${Math.floor(dur / 60_000)}m ${Math.floor((dur % 60_000) / 1000)}s`;
}
