import { useEffect, useState } from 'react';
import { KeyRound, Save, Trash2, RefreshCw, CheckCircle2, AlertCircle, Eye, EyeOff, ExternalLink } from 'lucide-react';
import { API_BASE } from '../../config';
import styles from './OAuthCredentialsPanel.module.css';

/**
 * OAuthCredentialsPanel (admin-only) — gestiona las credenciales OAuth de los
 * MCP providers (Google, GitHub, Spotify) sin necesidad de editar `.env`.
 *
 * Las credenciales se guardan cifradas en la DB via `/api/system-config/oauth/:provider`.
 * Los handlers del server las leen dinámicamente en cada request (no requiere restart).
 */

const PROVIDERS = [
  {
    id: 'google',
    name: 'Google (Calendar / Gmail / Drive / Tasks)',
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
    callbacks: [
      '/api/mcp-auth/callback/google-calendar',
      '/api/mcp-auth/callback/google-gmail',
      '/api/mcp-auth/callback/google-drive',
      '/api/mcp-auth/callback/google-tasks',
    ],
    instructions: 'Console Google Cloud → OAuth 2.0 Client IDs → habilitar Calendar/Gmail/Drive/Tasks APIs → agregar los 4 redirect URIs.',
  },
  {
    id: 'github',
    name: 'GitHub',
    docsUrl: 'https://github.com/settings/developers',
    callbacks: ['/api/mcp-auth/callback/github'],
    instructions: 'GitHub → Settings → Developer Settings → OAuth Apps → New OAuth App.',
  },
  {
    id: 'spotify',
    name: 'Spotify',
    docsUrl: 'https://developer.spotify.com/dashboard',
    callbacks: ['/api/mcp-auth/callback/spotify'],
    instructions: 'Spotify Developer Dashboard → Create App → Settings → Redirect URI. Se requiere cuenta Premium para control de reproducción.',
  },
];

export default function OAuthCredentialsPanel({ accessToken }) {
  const [status, setStatus] = useState(null);
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingProvider, setSavingProvider] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/system-config/oauth`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (accessToken) load(); }, [accessToken]);

  const save = async (provider, client_id, client_secret) => {
    setSavingProvider(provider);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/system-config/oauth/${provider}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ client_id, client_secret }),
      });
      if (!res.ok) throw new Error((await res.json())?.error || `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(`${provider}: ${e.message}`);
    } finally {
      setSavingProvider(null);
    }
  };

  const clear = async (provider) => {
    if (!confirm(`¿Eliminar credenciales OAuth de ${provider}?`)) return;
    setSavingProvider(provider);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/system-config/oauth/${provider}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(`${provider}: ${e.message}`);
    } finally {
      setSavingProvider(null);
    }
  };

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>
            <KeyRound size={20} aria-hidden="true" /> OAuth Credentials
          </h2>
          <p className={styles.subtitle}>
            Credenciales OAuth de providers MCP. Se guardan cifradas en la DB — no requiere editar <code>.env</code> ni reiniciar.
          </p>
        </div>
        <button className={styles.btnGhost} onClick={load} disabled={loading}>
          <RefreshCw size={14} className={loading ? styles.spin : ''} /> Refrescar
        </button>
      </header>

      {error && (
        <div className={styles.errorBanner}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      <div className={styles.grid}>
        {PROVIDERS.map(p => (
          <ProviderCard
            key={p.id}
            provider={p}
            state={status?.[p.id]}
            busy={savingProvider === p.id}
            onSave={(id, secret) => save(p.id, id, secret)}
            onClear={() => clear(p.id)}
          />
        ))}
      </div>

      <footer className={styles.footer}>
        Al guardar, los nuevos flujos de autorización usarán las credenciales actualizadas. Las apps ya conectadas no se ven afectadas.
      </footer>
    </div>
  );
}

function ProviderCard({ provider, state, busy, onSave, onClear }) {
  const [clientId, setClientId]         = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret]     = useState(false);
  const [origin, setOrigin]             = useState('');

  useEffect(() => {
    if (state?.client_id && !state.client_id.startsWith('(desde')) setClientId(state.client_id);
    setOrigin(`${window.location.protocol}//${window.location.host.replace(/:\d+$/, ':3001')}`);
  }, [state]);

  const handleSave = (e) => {
    e.preventDefault();
    if (!clientId.trim() || !clientSecret.trim()) return;
    onSave(clientId.trim(), clientSecret.trim());
    setClientSecret('');
  };

  const configured = state?.configured;
  const source = state?.source;

  return (
    <article className={`${styles.card} ${configured ? styles.cardOk : ''}`}>
      <header className={styles.cardHead}>
        <div className={styles.cardTitleRow}>
          <span className={styles.cardTitle}>{provider.name}</span>
          {configured ? (
            <span className={styles.badgeOk}>
              <CheckCircle2 size={12} /> Configurado ({source})
            </span>
          ) : (
            <span className={styles.badgeOff}>Sin credenciales</span>
          )}
        </div>
        <p className={styles.cardInstructions}>{provider.instructions}</p>
      </header>

      <div className={styles.callbacks}>
        <div className={styles.callbacksLabel}>Redirect URIs a registrar:</div>
        <ul className={styles.callbacksList}>
          {provider.callbacks.map(cb => (
            <li key={cb}><code>{origin}{cb}</code></li>
          ))}
        </ul>
      </div>

      <form onSubmit={handleSave} className={styles.form}>
        <label className={styles.label}>
          <span>Client ID</span>
          <input
            type="text"
            className={styles.input}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="1234567890-abc.apps.googleusercontent.com"
            autoComplete="off"
            spellCheck="false"
            required
          />
        </label>
        <label className={styles.label}>
          <span>Client Secret</span>
          <div className={styles.inputWithToggle}>
            <input
              type={showSecret ? 'text' : 'password'}
              className={styles.input}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={state?.has_secret ? '(guardado — dejar vacío para no cambiar)' : 'GOCSPX-...'}
              autoComplete="off"
              spellCheck="false"
              required={!state?.has_secret}
            />
            <button type="button" className={styles.toggleBtn} onClick={() => setShowSecret(v => !v)}>
              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>
        <div className={styles.actions}>
          <a className={styles.btnGhost} href={provider.docsUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> Consola del provider
          </a>
          {configured && (
            <button type="button" className={styles.btnDanger} onClick={onClear} disabled={busy}>
              <Trash2 size={12} /> Limpiar
            </button>
          )}
          <button type="submit" className={styles.btnPrimary} disabled={busy}>
            <Save size={12} /> {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </article>
  );
}
