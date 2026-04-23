import { useEffect, useState } from 'react';
import { lsp as api } from '../../api/advanced';
import styles from '../admin/AdminPanel.module.css';

/**
 * LSPStatusPanel (Fase E.4) — servers LSP configurados + disponibilidad en host.
 * Muestra instrucciones de install para cada lang faltante.
 */
export default function LSPStatusPanel({ accessToken }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = async () => {
    setError(null);
    try { setData(await api.status(accessToken)); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [accessToken]);

  const redetect = async () => {
    setBusy('detect');
    try { await api.detect(accessToken); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  const shutdown = async () => {
    if (!confirm('¿Detener todos los clientes LSP activos?')) return;
    setBusy('shutdown');
    try { await api.shutdown(accessToken); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  if (!data) return <div className={styles.root}><div className={styles.empty}>Cargando…</div></div>;

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>LSP status</h1>
          <p className={styles.subtitle}>
            Language Server Protocol — integración con tsserver/pylsp/rust-analyzer/gopls.
            {' '}
            <span className={`${styles.tag} ${data.enabled ? styles.tagSuccess : styles.tagWarning}`}>
              {data.enabled ? 'LSP_ENABLED=true' : 'LSP_ENABLED=false'}
            </span>
          </p>
        </div>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={redetect} disabled={busy === 'detect'}>
            {busy === 'detect' ? 'Detectando…' : 'Re-detect'}
          </button>
          <button className={`${styles.btn} ${styles.btnDanger}`} onClick={shutdown} disabled={busy === 'shutdown' || data.active.length === 0}>
            Shutdown all
          </button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Servers configurados</h2>
        {data.servers.length === 0 ? (
          <div className={styles.empty}>Sin servers configurados.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Lenguaje</th>
                <th>Comando</th>
                <th>Extensiones</th>
                <th>Estado</th>
                <th>Install</th>
              </tr>
            </thead>
            <tbody>
              {data.servers.map(s => (
                <tr key={s.language}>
                  <td style={{ fontWeight: 500 }}>{s.language}</td>
                  <td className={styles.mono}>{s.command}</td>
                  <td className={styles.mono} style={{ fontSize: 11 }}>
                    {(s.extensions || []).join(', ')}
                  </td>
                  <td>
                    <span className={`${styles.tag} ${s.available ? styles.tagSuccess : styles.tagError}`}>
                      {s.available ? 'disponible' : 'no instalado'}
                    </span>
                  </td>
                  <td className={styles.mono} style={{ fontSize: 11 }}>
                    {!s.available && installHint(s.language)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Workspaces activos ({data.active.length})</h2>
        {data.active.length === 0 ? (
          <div className={styles.empty}>Sin clientes LSP activos.</div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>Workspace</th><th>Lenguajes</th></tr></thead>
            <tbody>
              {data.active.map(w => (
                <tr key={w.workspaceRoot}>
                  <td className={styles.mono}>{w.workspaceRoot}</td>
                  <td>
                    {(w.languages || []).map(l => <span key={l} className={styles.tag} style={{ marginRight: 4 }}>{l}</span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function installHint(lang) {
  const hints = {
    ts: 'npm i -g typescript-language-server typescript',
    py: 'pip install python-lsp-server',
    rust: 'rustup component add rust-analyzer',
    go: 'go install golang.org/x/tools/gopls@latest',
  };
  return hints[lang] || 'ver docs del lenguaje';
}
