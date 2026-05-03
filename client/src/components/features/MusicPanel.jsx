import { useEffect, useState, useMemo } from 'react';
import { Music, Play, SkipBack, SkipForward, Pause, Search, RefreshCw, ExternalLink, Plus, AlertCircle, MessageSquare, Disc3 } from 'lucide-react';
import { API_BASE } from '../../config';
import { useUIStore } from '../../stores/uiStore';
import styles from './MusicPanel.module.css';

/**
 * MusicPanel — Spotify (Fase 5.4 roadmap).
 *
 * El control directo ocurre via MCP server de Spotify (OAuth). Este panel:
 *  - Detecta si el MCP existe.
 *  - Sin MCP → setup instructions.
 *  - Con MCP → ejemplos + link al chat para invocar comandos (el agente
 *    tiene acceso a las tools del MCP: play, pause, search, etc.).
 */
export default function MusicPanel({ accessToken }) {
  const [mcps, setMcps] = useState(null);
  const [tools, setTools] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const setSection = useUIStore((s) => s.setSection);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/mcps`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMcps(await res.json());
      try {
        const tRes = await fetch(`${API_BASE}/api/tools/all`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (tRes.ok) setTools(await tRes.json());
      } catch { /* noop */ }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (accessToken) load(); }, [accessToken]);

  const spMcp = useMemo(() => (mcps || []).find(m => /spotif/i.test(m.name || '')), [mcps]);

  const spTools = useMemo(() => {
    if (!tools || !Array.isArray(tools)) return [];
    return tools.filter(t => /spotif/i.test((t.name || '') + ' ' + (t.source || t.mcp || '')));
  }, [tools]);

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>
            <Music size={20} aria-hidden="true" /> Música
          </h2>
          <p className={styles.subtitle}>
            Controla Spotify por voz o texto. Busca, reproduce, pausa y agrega a playlist.
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

      {!loading && !spMcp && (
        <section className={styles.setupCard}>
          <div className={styles.setupHead}>
            <span className={styles.setupBadge}>No conectado</span>
            <h3>Conectá Spotify</h3>
          </div>
          <p className={styles.setupDesc}>
            Spotify se controla vía un MCP server que maneja OAuth y streaming. Necesitás una cuenta <strong>Spotify Premium</strong> para control de reproducción.
          </p>
          <ol className={styles.steps}>
            <li>
              <strong>Creá una app en Spotify Developer</strong>: <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">developer.spotify.com/dashboard <ExternalLink size={10} /></a>.
              Agregá <code>http://localhost:8888/callback</code> como Redirect URI.
            </li>
            <li>
              <strong>Agregá el MCP</strong> en el tab <em>MCPs</em> → Add:
              <pre className={styles.code}>{`{
  "name": "spotify",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-spotify"],
  "env": {
    "SPOTIFY_CLIENT_ID": "<del dashboard>",
    "SPOTIFY_CLIENT_SECRET": "<del dashboard>"
  }
}`}</pre>
            </li>
            <li>
              <strong>Habilitá y autenticá</strong>: activá el MCP, y usá el tab <em>MCP OAuth</em> para completar el flujo de autorización.
            </li>
          </ol>
          <div className={styles.setupActions}>
            <button className={styles.btnPrimary} onClick={() => setSection('config', { configTab: 'mcps' })}>
              <Plus size={14} /> Ir a MCPs
            </button>
            <a
              className={styles.btnGhost}
              href="https://developer.spotify.com/documentation/web-api"
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={12} /> Docs Spotify
            </a>
          </div>
        </section>
      )}

      {!loading && spMcp && (
        <>
          <section className={styles.playerCard}>
            <div className={styles.playerLeft}>
              <div className={styles.albumArt}>
                <Disc3 size={48} aria-hidden="true" />
              </div>
              <div className={styles.trackInfo}>
                <div className={styles.trackTitle}>Control desde el chat</div>
                <div className={styles.trackArtist}>El agente tiene acceso a {spTools.length || 'las'} herramientas de Spotify</div>
              </div>
            </div>
            <div className={styles.playerControls}>
              <button className={styles.playerBtn} title="Abrir chat para controlar" onClick={() => setSection('chat')}>
                <SkipBack size={18} />
              </button>
              <button className={styles.playerBtnPrimary} onClick={() => setSection('chat')} title="Ir al chat">
                <Play size={20} />
              </button>
              <button className={styles.playerBtn} onClick={() => setSection('chat')}>
                <SkipForward size={18} />
              </button>
            </div>
          </section>

          <section className={styles.exampleGrid}>
            <ExampleCard Icon={Play}   label="Reproducir"      example='Poné "Hotel California"' />
            <ExampleCard Icon={Pause}  label="Pausar"          example="Pausá la música" />
            <ExampleCard Icon={Search} label="Buscar"          example='Buscá canciones de Radiohead' />
            <ExampleCard Icon={Music}  label="Playlist"        example='Agregá esta canción a mi playlist "Rock 90s"' />
          </section>

          <div className={styles.connectedActions}>
            <button className={styles.btnPrimary} onClick={() => setSection('chat')}>
              <MessageSquare size={14} /> Abrir Chat
            </button>
            <button className={styles.btnGhost} onClick={() => setSection('config', { configTab: 'mcps' })}>
              Configurar MCP <ExternalLink size={12} />
            </button>
          </div>

          {spTools.length > 0 && (
            <details className={styles.toolsDetails}>
              <summary>{spTools.length} herramienta(s) disponibles</summary>
              <ul className={styles.toolList}>
                {spTools.map(t => (
                  <li key={t.name}><code>{t.name}</code>{t.description && <span> — {t.description}</span>}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function ExampleCard({ Icon, label, example }) {
  return (
    <div className={styles.example}>
      <span className={styles.exampleIcon}><Icon size={16} aria-hidden="true" /></span>
      <div>
        <div className={styles.exampleLabel}>{label}</div>
        <div className={styles.exampleText}>"{example}"</div>
      </div>
    </div>
  );
}
