import { useEffect, useRef, useState } from 'react';
import { mcpAuth as api } from '../../api/features';
import styles from '../admin/AdminPanel.module.css';

/**
 * McpOAuthWizard (Fase C.6) — flujo interactivo para autenticar MCPs vía OAuth.
 *
 * Flow:
 *   1. GET /api/mcp-auth/providers — lista providers con handler registrado.
 *   2. User click "Conectar" → POST /api/mcp-auth/start/:provider → {auth_url, state}.
 *   3. Abrimos auth_url en window.open; el provider redirige al callback del server.
 *   4. Polling GET /api/mcp-auth/status/:state cada 2s hasta status !== 'pending'.
 *   5. Mostramos result (success/error) y limpiamos estado.
 */
export default function McpOAuthWizard({ accessToken }) {
  const [providers, setProviders] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [activeFlow, setActiveFlow] = useState(null); // { provider, state, status }
  const pollRef = useRef(null);

  useEffect(() => {
    setError(null);
    api.providers(accessToken).then(setProviders).catch(e => setError(e.message));
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [accessToken]);

  const start = async (provider, mcp_name) => {
    setError(null);
    setBusy(provider);
    try {
      const { state, auth_url } = await api.start(accessToken, provider, { mcp_name: mcp_name || provider });
      if (!auth_url) throw new Error(`Provider "${provider}" no expone buildAuthUrl — auth manual requerida`);
      setActiveFlow({ provider, state, status: 'pending' });
      window.open(auth_url, '_blank', 'noopener,noreferrer');

      // Poll cada 2s hasta completed/error/unknown
      pollRef.current = setInterval(async () => {
        try {
          const st = await api.status(accessToken, state);
          setActiveFlow({ provider, state, ...st });
          if (st.status !== 'pending') {
            clearInterval(pollRef.current); pollRef.current = null;
            setBusy(null);
          }
        } catch {
          // ignore transient errors
        }
      }, 2000);
    } catch (e) {
      setError(e.message);
      setBusy(null);
    }
  };

  const cancel = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setActiveFlow(null);
    setBusy(null);
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>MCP OAuth</h1>
          <p className={styles.subtitle}>
            Conectar MCPs que requieren OAuth (Gmail, Drive, Calendar, GitHub, etc). El token se cifra y persiste por user.
          </p>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {activeFlow && (
        <section className={styles.card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong>Flow activo: {activeFlow.provider}</strong>
            <span className={`${styles.tag} ${statusTag(activeFlow.status)}`}>
              {activeFlow.status}
            </span>
            <span style={{ marginLeft: 'auto' }}>
              <button className={styles.btn} onClick={cancel}>
                {activeFlow.status === 'pending' ? 'Cancelar' : 'Cerrar'}
              </button>
            </span>
          </div>
          {activeFlow.status === 'pending' && (
            <p style={{ marginTop: 12, color: 'var(--oc2-text-weak)' }}>
              Completar auth en la ventana abierta. Pollear cada 2s…
            </p>
          )}
          {activeFlow.status === 'completed' && (
            <p style={{ marginTop: 12, color: 'var(--oc2-success)' }}>
              ✓ Conectado. MCP "{activeFlow.mcp_name}" listo para usar.
            </p>
          )}
          {activeFlow.status === 'error' && (
            <p style={{ marginTop: 12, color: 'var(--oc2-error)' }}>
              ✗ Error: {activeFlow.error || 'desconocido'}
            </p>
          )}
          {activeFlow.status === 'unknown' && (
            <p style={{ marginTop: 12, color: 'var(--oc2-text-weak)' }}>
              State no encontrado. Probablemente expiró (10 min) o el callback nunca llegó.
            </p>
          )}
        </section>
      )}

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Providers disponibles</h2>
        {providers === null ? <div className={styles.empty}>Cargando…</div> : providers.length === 0 ? (
          <div className={styles.empty} style={{ lineHeight: 1.6 }}>
            <strong>Ningún provider OAuth activo.</strong> El server viene con handlers para Google (Calendar/Gmail/Drive/Tasks), GitHub y Spotify — se auto-registran si configurás las credenciales.
            <br /><br />
            <strong>Para habilitarlos:</strong>
            <ol style={{ margin: '8px 0 0 18px', padding: 0 }}>
              <li>Crear app OAuth en el provider (Google Cloud Console, GitHub Developer Settings, Spotify Dashboard).</li>
              <li>Agregar redirect URI: <code>http://TU_HOST:3001/api/mcp-auth/callback/&lt;provider&gt;</code></li>
              <li>Setear env vars en <code>server/.env</code>:
                <pre style={{ marginTop: 6, padding: 10, background: 'var(--bg-input)', borderRadius: 6, fontSize: 11, whiteSpace: 'pre-wrap' }}>{`GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...`}</pre>
              </li>
              <li>Reiniciar el server. Los handlers cuyas env vars existan se registran automáticamente (log: <code>[mcp-oauth] ... registrado</code>).</li>
            </ol>
            <br />
            <em>Nota: la mayoría de los MCPs manejan OAuth por sí mismos cuando se spawnean. Este wizard es para MCPs que deleguen el OAuth al server.</em>
          </div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>Provider</th><th></th></tr></thead>
            <tbody>
              {providers.map(p => (
                <tr key={p}>
                  <td>{p}</td>
                  <td>
                    <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy === p || (activeFlow && activeFlow.status === 'pending')} onClick={() => start(p)}>
                      {busy === p ? 'Iniciando…' : 'Conectar'}
                    </button>
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

function statusTag(s) {
  if (s === 'completed') return styles.tagSuccess;
  if (s === 'error') return styles.tagError;
  if (s === 'pending') return styles.tagInfo;
  return styles.tagWarning;
}
