import { useEffect, useState } from 'react';
import { workspaces as api } from '../../api/admin';
import styles from './AdminPanel.module.css';

/**
 * WorkspacesPanel — admin-only. Lista workspaces activos (git-worktrees,
 * Docker containers, SSH sessions) + release manual.
 */
export default function WorkspacesPanel({ accessToken }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = async () => {
    setError(null);
    try { setData(await api.list(accessToken) || {}); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [accessToken]);

  const release = async (id) => {
    if (!confirm(`¿Liberar workspace ${id}? El subagente que lo use perderá el contexto.`)) return;
    setBusy(id);
    try { await api.release(accessToken, id); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Workspaces</h1>
          <p className={styles.subtitle}>Workspaces activos por provider. Subagentes tipo <code>code</code> usan git-worktrees; Docker/SSH están detrás de <code>WORKSPACE_ADAPTORS_ENABLED</code>.</p>
        </div>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={load}>Refresh</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {data === null ? <div className={styles.empty}>Cargando…</div> : (
        Object.entries(data).map(([provider, info]) => (
          <section key={provider} className={styles.card}>
            <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
              <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, color: 'var(--oc2-text-strong)', textTransform: 'capitalize' }}>{provider}</h2>
              <span className={`${styles.tag} ${info.enabled ? styles.tagSuccess : ''}`}>
                {info.enabled ? 'habilitado' : 'deshabilitado'}
              </span>
              {info.error && <span className={`${styles.tag} ${styles.tagError}`}>error: {info.error}</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--oc2-text-weak)', fontSize: 12 }}>
                {Array.isArray(info.workspaces) ? info.workspaces.length : 0} activos
              </span>
            </header>
            {!info.enabled ? (
              <div className={styles.empty}>Provider no activado.</div>
            ) : !info.workspaces || info.workspaces.length === 0 ? (
              <div className={styles.empty}>Sin workspaces activos.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Info</th>
                    <th>Creado</th>
                    <th>Último acceso</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {info.workspaces.map(ws => (
                    <tr key={ws.id}>
                      <td className={styles.mono}>{ws.id}</td>
                      <td className={styles.mono} style={{ fontSize: 11, maxWidth: 400 }}>
                        {formatInfo(ws)}
                      </td>
                      <td className={styles.mono}>{formatDate(ws.createdAt)}</td>
                      <td className={styles.mono}>{formatDate(ws.lastAccessAt)}</td>
                      <td>
                        <button className={`${styles.btn} ${styles.btnDanger}`} disabled={busy === ws.id} onClick={() => release(ws.id)}>
                          {busy === ws.id ? '…' : 'Liberar'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))
      )}
    </div>
  );
}

function formatInfo(ws) {
  const parts = [];
  if (ws.path) parts.push(`path=${ws.path}`);
  if (ws.branch) parts.push(`branch=${ws.branch}`);
  if (ws.containerId) parts.push(`container=${String(ws.containerId).slice(0, 12)}`);
  if (ws.containerName) parts.push(`name=${ws.containerName}`);
  if (ws.hostPath) parts.push(`host=${ws.hostPath}`);
  if (ws.remotePath) parts.push(`remote=${ws.remotePath}`);
  return parts.join(' · ') || '—';
}

function formatDate(ms) {
  if (!ms) return '—';
  try {
    const d = new Date(ms);
    const now = Date.now();
    const ageMs = now - ms;
    if (ageMs < 60_000) return `hace ${Math.round(ageMs / 1000)}s`;
    if (ageMs < 3600_000) return `hace ${Math.round(ageMs / 60_000)}m`;
    if (ageMs < 24 * 3600_000) return `hace ${Math.round(ageMs / 3600_000)}h`;
    return d.toISOString().slice(0, 10);
  } catch { return '—'; }
}
