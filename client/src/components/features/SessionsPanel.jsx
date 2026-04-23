import { useEffect, useState } from 'react';
import { sessions as api } from '../../api/features';
import styles from '../admin/AdminPanel.module.css';

/**
 * SessionsPanel (Fase C.4) — 2 tabs:
 *   1. Sesiones activas — sessions con info (cwd, provider, agent).
 *   2. Shares — tokens generados, revoke, link directo.
 *
 * Usa endpoints existentes /api/sessions y /api/session-share (Fase 12.4).
 */
export default function SessionsPanel({ accessToken }) {
  const [tab, setTab] = useState('active');
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [shareTarget, setShareTarget] = useState(null);

  const load = async () => {
    setError(null);
    try {
      if (tab === 'active') setItems(await api.list(accessToken) || []);
      else setItems(await api.listShares(accessToken) || []);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [tab, accessToken]);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Sessions</h1>
          <p className={styles.subtitle}>Sesiones activas y share tokens para acceso multi-device (Fase 12.4).</p>
        </div>
        <div className={styles.actions}>
          <button className={`${styles.btn} ${tab === 'active' ? styles.btnPrimary : ''}`} onClick={() => setTab('active')}>Activas</button>
          <button className={`${styles.btn} ${tab === 'shares' ? styles.btnPrimary : ''}`} onClick={() => setTab('shares')}>Shares</button>
          <button className={styles.btn} onClick={load}>Refresh</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {tab === 'active' && (
        <ActiveSessions items={items} accessToken={accessToken} onShareClick={setShareTarget} onReload={load} />
      )}

      {tab === 'shares' && (
        <SharesList items={items} accessToken={accessToken} onReload={load} />
      )}

      {shareTarget && <ShareModal session={shareTarget} accessToken={accessToken} onClose={() => { setShareTarget(null); if (tab === 'shares') load(); }} onError={setError} />}
    </div>
  );
}

function ActiveSessions({ items, onShareClick }) {
  if (items === null) return <div className={styles.card}><div className={styles.empty}>Cargando…</div></div>;
  if (items.length === 0) return <div className={styles.card}><div className={styles.empty}>Sin sesiones activas.</div></div>;
  return (
    <section className={styles.card}>
      <table className={styles.table}>
        <thead><tr><th>ID</th><th>Tipo</th><th>cwd</th><th>Provider / Model</th><th>Iniciada</th><th></th></tr></thead>
        <tbody>
          {items.map(s => (
            <tr key={s.id}>
              <td className={styles.mono}>{s.id}</td>
              <td><span className={styles.tag}>{s.type || 'pty'}</span></td>
              <td className={styles.mono} style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.cwd || '—'}</td>
              <td className={styles.mono}>{[s.provider, s.model].filter(Boolean).join(' / ') || '—'}</td>
              <td className={styles.mono}>{formatAgo(s.createdAt || s.created_at)}</td>
              <td>
                <button className={styles.btn} onClick={() => onShareClick(s)}>Compartir</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SharesList({ items, accessToken, onReload }) {
  const [busy, setBusy] = useState(null);

  const revoke = async (token) => {
    if (!confirm('¿Revocar este share?')) return;
    setBusy(token);
    try {
      await api.revokeShare(accessToken, token);
      await onReload();
    } catch (e) { alert(e.message); }
    finally { setBusy(null); }
  };

  if (items === null) return <div className={styles.card}><div className={styles.empty}>Cargando…</div></div>;
  if (items.length === 0) return <div className={styles.card}><div className={styles.empty}>Sin shares activos.</div></div>;

  return (
    <section className={styles.card}>
      <table className={styles.table}>
        <thead><tr><th>Session ID</th><th>Token</th><th>Permissions</th><th>Expira</th><th></th></tr></thead>
        <tbody>
          {items.map(s => (
            <tr key={s.token}>
              <td className={styles.mono}>{s.session_id}</td>
              <td className={styles.mono} style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.token}</td>
              <td>
                {s.permissions?.read && <span className={styles.tag}>read</span>}
                {s.permissions?.write && <span className={`${styles.tag} ${styles.tagWarning}`} style={{ marginLeft: 4 }}>write</span>}
              </td>
              <td className={styles.mono}>{s.expires_at ? formatDate(s.expires_at) : '∞'}</td>
              <td>
                <button className={styles.btn} disabled={busy === s.token} onClick={() => revoke(s.token)}>Revocar</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ShareModal({ session, accessToken, onClose, onError }) {
  const [ttlHours, setTtlHours] = useState(24);
  const [allowWrite, setAllowWrite] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const r = await api.share(accessToken, session.id, {
        ttlHours: Number(ttlHours),
        permissions: { read: true, write: !!allowWrite },
      });
      setResult(r);
    } catch (e) { onError(e.message); onClose(); }
    finally { setBusy(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div className={styles.card} style={{ maxWidth: 520, width: '90%' }}>
        <h2 style={{ fontSize: 16, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Compartir sesión {session.id}</h2>
        {!result ? (
          <>
            <div className={styles.field} style={{ marginBottom: 12 }}>
              <label className={styles.label}>TTL (horas)</label>
              <input className={styles.input} type="number" min={1} max={720} value={ttlHours} onChange={e => setTtlHours(e.target.value)} />
            </div>
            <div className={styles.field} style={{ marginBottom: 12 }}>
              <label className={styles.label}>
                <input type="checkbox" checked={allowWrite} onChange={e => setAllowWrite(e.target.checked)} style={{ marginRight: 6 }} />
                Permitir escribir (no solo leer)
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className={styles.btn} onClick={onClose}>Cancelar</button>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={create} disabled={busy}>
                {busy ? 'Creando…' : 'Crear share'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: 12, background: 'var(--oc2-surface-success, rgba(18,201,5,0.1))', border: '1px solid var(--oc2-success)', borderRadius: 6, marginBottom: 12 }}>
              ✓ Share creado. Token:
            </div>
            <input className={styles.input} readOnly value={result.token} onClick={e => e.target.select()} style={{ marginBottom: 12 }} />
            <p style={{ fontSize: 12, color: 'var(--oc2-text-weak)', marginBottom: 12 }}>
              Otro dispositivo puede conectarse via WebSocket con <code>sessionType: 'shared'</code> + este token, o via <code>GET /api/session-share/&lt;token&gt;</code>.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={onClose}>Cerrar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatAgo(ms) {
  if (!ms) return '—';
  const age = Date.now() - ms;
  if (age < 60_000) return `${Math.round(age / 1000)}s`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m`;
  return `${Math.round(age / 3_600_000)}h`;
}
function formatDate(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); } catch { return '—'; }
}
