import { useEffect, useState, useMemo } from 'react';
import { CheckCircle2, Circle, ExternalLink, Plus, RefreshCw, Mail, Calendar, ListTodo, HardDriveDownload, Music, Home, MessageSquare, Hash, Send as TelegramIcon, Globe, Database, X, Copy, Check } from 'lucide-react';
import { API_BASE } from '../../config';
import { useUIStore } from '../../stores/uiStore';
import styles from './IntegrationsPanel.module.css';

/**
 * Catálogo de integraciones conocidas. Cada una define:
 *   - mcpMatches: patrones (substring, case-insensitive) que matchean contra
 *                 los names de los MCPs configurados en el server.
 *   - oauth: true si la integración usa el wizard de OAuth (MCP OAuth tab).
 *   - setup: { mcpJson, docsUrl, notes } — contenido del modal de setup.
 */
const CATALOG = [
  {
    id: 'gcal', name: 'Google Calendar', Icon: Calendar, category: 'google',
    mcpMatches: ['calendar', 'google-calendar', 'gcal'], oauth: true,
    desc: 'Eventos, agenda, invitaciones.',
    setup: {
      docsUrl: 'https://developers.google.com/calendar/api/guides/overview',
      notes: 'Requiere OAuth2. Usá el tab MCP OAuth para conectar tu cuenta.',
      mcpJson: {
        name: 'google-calendar',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-google-calendar'],
        env: { GOOGLE_CLIENT_ID: '<del console.cloud.google.com>', GOOGLE_CLIENT_SECRET: '<idem>' },
      },
    },
  },
  {
    id: 'gmail', name: 'Gmail', Icon: Mail, category: 'google',
    mcpMatches: ['gmail', 'google-gmail', 'google_mail'], oauth: true,
    desc: 'Leer, buscar y enviar correos.',
    setup: {
      docsUrl: 'https://developers.google.com/gmail/api/guides',
      notes: 'OAuth2 con scopes gmail.readonly + gmail.send. Config en Google Cloud Console.',
      mcpJson: {
        name: 'gmail',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-gmail'],
        env: { GOOGLE_CLIENT_ID: '<client_id>', GOOGLE_CLIENT_SECRET: '<client_secret>' },
      },
    },
  },
  {
    id: 'gtasks', name: 'Google Tasks', Icon: ListTodo, category: 'google',
    mcpMatches: ['gtasks', 'google-tasks'], oauth: true,
    desc: 'Lista de tareas sincronizada.',
    setup: {
      docsUrl: 'https://developers.google.com/tasks',
      notes: 'OAuth2 scope tasks. Se puede reusar el client ID de Calendar.',
      mcpJson: {
        name: 'google-tasks',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-google-tasks'],
        env: { GOOGLE_CLIENT_ID: '<client_id>', GOOGLE_CLIENT_SECRET: '<client_secret>' },
      },
    },
  },
  {
    id: 'gdrive', name: 'Google Drive', Icon: HardDriveDownload, category: 'google',
    mcpMatches: ['gdrive', 'google-drive', 'drive'], oauth: true,
    desc: 'Búsqueda y lectura de documentos.',
    setup: {
      docsUrl: 'https://developers.google.com/drive/api/guides/about-sdk',
      notes: 'OAuth2 con scope drive.readonly como mínimo.',
      mcpJson: {
        name: 'gdrive',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-gdrive'],
        env: { GDRIVE_CREDS_PATH: '~/.gdrive/creds.json' },
      },
    },
  },
  {
    id: 'spotify', name: 'Spotify', Icon: Music, category: 'media',
    mcpMatches: ['spotify'], oauth: true,
    desc: 'Control de reproducción y búsqueda.',
    setup: {
      docsUrl: 'https://developer.spotify.com/documentation/web-api',
      notes: 'Requiere Spotify Premium para control de reproducción. Crear app en developer.spotify.com.',
      mcpJson: {
        name: 'spotify',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-spotify'],
        env: { SPOTIFY_CLIENT_ID: '<del dashboard>', SPOTIFY_CLIENT_SECRET: '<idem>' },
      },
    },
  },
  {
    id: 'ha', name: 'Home Assistant', Icon: Home, category: 'home',
    mcpMatches: ['homeassistant', 'home-assistant', 'ha'], oauth: false,
    desc: 'Luces, temperatura, sensores.',
    setup: {
      docsUrl: 'https://www.home-assistant.io/docs/authentication/#your-account-profile',
      notes: 'Genera un token de larga duración en tu perfil de HA y usalo en HA_TOKEN.',
      mcpJson: {
        name: 'homeassistant',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-homeassistant'],
        env: { HA_URL: 'http://tu-ha.local:8123', HA_TOKEN: '<tu-token>' },
      },
    },
  },
  {
    id: 'slack', name: 'Slack', Icon: Hash, category: 'comms',
    mcpMatches: ['slack'], oauth: true,
    desc: 'Leer y enviar mensajes.',
    setup: {
      docsUrl: 'https://api.slack.com/apps',
      notes: 'Crear Slack App con scopes chat:write + channels:read.',
      mcpJson: {
        name: 'slack',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-slack'],
        env: { SLACK_BOT_TOKEN: 'xoxb-...', SLACK_TEAM_ID: '<team>' },
      },
    },
  },
  {
    id: 'tg', name: 'Telegram', Icon: TelegramIcon, category: 'comms',
    mcpMatches: ['telegram'], oauth: false,
    desc: 'Bots ya configurados desde el panel Telegram.',
    setup: {
      docsUrl: 'https://core.telegram.org/bots',
      notes: 'Telegram se gestiona desde la sección Telegram del sidebar (no requiere MCP).',
      mcpJson: null,
      specialLink: { label: 'Ir a Telegram', section: 'telegram' },
    },
  },
  {
    id: 'web', name: 'Web Search', Icon: Globe, category: 'data',
    mcpMatches: ['brave', 'brave-search', 'websearch', 'search'], oauth: false,
    desc: 'Búsqueda web para respuestas al día.',
    setup: {
      docsUrl: 'https://brave.com/search/api/',
      notes: 'API key gratuita hasta 2000 req/mes en brave.com/search/api.',
      mcpJson: {
        name: 'brave-search',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-brave-search'],
        env: { BRAVE_API_KEY: '<tu-key>' },
      },
    },
  },
  {
    id: 'sqlite', name: 'SQLite local', Icon: Database, category: 'data',
    mcpMatches: ['sqlite', 'duckdb', 'postgres'], oauth: false,
    desc: 'Consulta directa de bases de datos.',
    setup: {
      docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
      notes: 'Apuntá a tu DB con DB_PATH. El agente podrá hacer SELECTs y schema queries.',
      mcpJson: {
        name: 'sqlite',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '/ruta/a/tu.db'],
      },
    },
  },
  {
    id: 'discord', name: 'Discord', Icon: MessageSquare, category: 'comms',
    mcpMatches: ['discord'], oauth: true,
    desc: 'Canales y mensajes directos.',
    setup: {
      docsUrl: 'https://discord.com/developers/docs/intro',
      notes: 'Crear bot app en discord.com/developers y usar DISCORD_BOT_TOKEN.',
      mcpJson: {
        name: 'discord',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-discord'],
        env: { DISCORD_BOT_TOKEN: '<bot-token>' },
      },
    },
  },
];

const CATEGORIES = [
  { id: 'google', label: 'Google' },
  { id: 'home',   label: 'Hogar' },
  { id: 'media',  label: 'Media' },
  { id: 'comms',  label: 'Comunicación' },
  { id: 'data',   label: 'Datos' },
];

function getMcpMatch(mcps, matches) {
  const lower = matches.map(m => m.toLowerCase());
  return (mcps || []).find(m => {
    const name = (m.name || '').toLowerCase();
    return lower.some(sub => name.includes(sub));
  });
}

export default function IntegrationsPanel({ accessToken }) {
  const [mcps, setMcps] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [setupItem, setSetupItem] = useState(null); // integration open in modal
  const setSection = useUIStore((s) => s.setSection);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/mcps`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMcps(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
      setMcps([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (accessToken) load(); }, [accessToken]);

  const stats = useMemo(() => {
    let connected = 0;
    for (const item of CATALOG) {
      if (getMcpMatch(mcps, item.mcpMatches)) connected++;
    }
    return { connected, total: CATALOG.length };
  }, [mcps]);

  const visible = filter === 'all' ? CATALOG : CATALOG.filter(c => c.category === filter);

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>Integraciones</h2>
          <p className={styles.subtitle}>
            Conecta servicios externos (Google, Spotify, Home Assistant, etc.) vía MCP.
            <span className={styles.counter}> {stats.connected}/{stats.total} conectadas</span>
          </p>
        </div>
        <div className={styles.actions}>
          <button className={styles.btnGhost} onClick={load} disabled={loading} aria-label="Refrescar">
            <RefreshCw size={14} className={loading ? styles.spin : ''} /> Refrescar
          </button>
          <button className={styles.btnPrimary} onClick={() => setSection('config', { configTab: 'mcps' })}>
            <Plus size={14} /> Agregar MCP manual
          </button>
        </div>
      </header>

      {error && (
        <div className={styles.errorBanner}>
          No se pudo cargar la lista de MCPs: {error}
        </div>
      )}

      <div className={styles.filters}>
        <button
          className={`${styles.filterChip} ${filter === 'all' ? styles.active : ''}`}
          onClick={() => setFilter('all')}
        >
          Todas ({CATALOG.length})
        </button>
        {CATEGORIES.map(c => (
          <button
            key={c.id}
            className={`${styles.filterChip} ${filter === c.id ? styles.active : ''}`}
            onClick={() => setFilter(c.id)}
          >
            {c.label} ({CATALOG.filter(i => i.category === c.id).length})
          </button>
        ))}
      </div>

      <div className={styles.grid}>
        {visible.map(item => {
          const mcp = getMcpMatch(mcps, item.mcpMatches);
          const connected = !!mcp;
          return (
            <article key={item.id} className={`${styles.card} ${connected ? styles.cardOk : ''}`}>
              <div className={styles.cardHead}>
                <span className={styles.cardIcon}><item.Icon size={18} aria-hidden="true" /></span>
                <span className={styles.cardTitle}>{item.name}</span>
                {connected
                  ? <span className={styles.statusOk}><CheckCircle2 size={14} /> Conectada</span>
                  : <span className={styles.statusOff}><Circle size={14} /> No configurada</span>}
              </div>
              <p className={styles.cardDesc}>{item.desc}</p>
              {mcp && (
                <div className={styles.cardMeta}>
                  MCP: <code>{mcp.name}</code>
                  {mcp.enabled === false && <span className={styles.tag}>disabled</span>}
                </div>
              )}
              <div className={styles.cardActions}>
                {connected ? (
                  <>
                    {item.id === 'ha'      && <button className={styles.btnPrimary} onClick={() => setSection('devices')}>Abrir Dispositivos</button>}
                    {item.id === 'spotify' && <button className={styles.btnPrimary} onClick={() => setSection('music')}>Abrir Música</button>}
                    {item.id === 'tg'      && <button className={styles.btnPrimary} onClick={() => setSection('telegram')}>Abrir Telegram</button>}
                    <button className={styles.btnGhost} onClick={() => setSection('config', { configTab: 'mcps' })}>
                      Gestionar MCP <ExternalLink size={12} />
                    </button>
                  </>
                ) : (
                  <>
                    <button className={styles.btnPrimary} onClick={() => setSetupItem(item)}>
                      <Plus size={12} /> Configurar
                    </button>
                    {item.oauth && (
                      <button className={styles.btnGhost} onClick={() => setSection('config', { configTab: 'mcpOAuth' })}>
                        OAuth wizard <ExternalLink size={12} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {!loading && mcps?.length > 0 && (
        <footer className={styles.footer}>
          <details>
            <summary>{mcps.length} MCP(s) configurados en total</summary>
            <ul className={styles.mcpList}>
              {mcps.map(m => (
                <li key={m.name}>
                  <code>{m.name}</code>
                  <span className={m.enabled === false ? styles.tagOff : styles.tagOn}>
                    {m.enabled === false ? 'disabled' : 'enabled'}
                  </span>
                  {m.transport && <span className={styles.tag}>{m.transport}</span>}
                </li>
              ))}
            </ul>
          </details>
        </footer>
      )}

      {setupItem && (
        <SetupModal
          item={setupItem}
          onClose={() => setSetupItem(null)}
          onGoToMcps={() => { setSetupItem(null); setSection('config', { configTab: 'mcps' }); }}
          onGoToOAuth={() => { setSetupItem(null); setSection('config', { configTab: 'mcpOAuth' }); }}
          onGoToSection={(sec) => { setSetupItem(null); setSection(sec); }}
        />
      )}
    </div>
  );
}

function SetupModal({ item, onClose, onGoToMcps, onGoToOAuth, onGoToSection }) {
  const [copied, setCopied] = useState(false);
  const jsonStr = item.setup.mcpJson
    ? JSON.stringify(item.setup.mcpJson, null, 2)
    : null;

  const copyJson = async () => {
    if (!jsonStr) return;
    try {
      await navigator.clipboard.writeText(jsonStr);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* fallback: select-all? */ }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Configurar ${item.name}`}>
        <header className={styles.modalHead}>
          <div className={styles.modalTitle}>
            <span className={styles.cardIcon}><item.Icon size={18} /></span>
            <div>
              <h3>Conectar {item.name}</h3>
              <p>{item.desc}</p>
            </div>
          </div>
          <button className={styles.modalClose} onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </header>

        <div className={styles.modalBody}>
          <p className={styles.modalNotes}>{item.setup.notes}</p>

          {jsonStr && (
            <>
              <div className={styles.modalLabel}>
                Config MCP (copiar y pegar en <em>Configuración → MCPs → Add</em>):
              </div>
              <div className={styles.codeWrap}>
                <pre className={styles.code}>{jsonStr}</pre>
                <button className={styles.copyBtn} onClick={copyJson}>
                  {copied ? <><Check size={12} /> Copiado</> : <><Copy size={12} /> Copiar</>}
                </button>
              </div>
            </>
          )}

          {item.setup.specialLink && (
            <div className={styles.modalNotes}>
              Esta integración no requiere MCP. Andá directo a su sección.
            </div>
          )}
        </div>

        <footer className={styles.modalFoot}>
          <a className={styles.btnGhost} href={item.setup.docsUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> Docs oficiales
          </a>
          {item.setup.specialLink ? (
            <button className={styles.btnPrimary} onClick={() => onGoToSection(item.setup.specialLink.section)}>
              {item.setup.specialLink.label} →
            </button>
          ) : item.oauth ? (
            <button className={styles.btnPrimary} onClick={onGoToOAuth}>
              Abrir OAuth wizard →
            </button>
          ) : (
            <button className={styles.btnPrimary} onClick={onGoToMcps}>
              Ir a MCPs → Add →
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
