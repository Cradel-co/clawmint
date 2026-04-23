import { useEffect, useState, useMemo } from 'react';
import { Home, Lightbulb, Thermometer, Radio, Wifi, RefreshCw, ExternalLink, Plus, AlertCircle, MessageSquare } from 'lucide-react';
import { API_BASE } from '../../config';
import { useUIStore } from '../../stores/uiStore';
import styles from './DevicesPanel.module.css';

/**
 * DevicesPanel — dispositivos Home Assistant (Fase 5.1 roadmap).
 *
 * Como la integración directa con HA corre a través de un MCP server (ej.
 * `homeassistant` MCP), este panel detecta si está configurado y:
 *  - Si no: muestra guía de setup paso a paso.
 *  - Si sí: sugiere controlar los dispositivos desde el chat (el agente
 *    tiene acceso a las tools de HA) y lista las tools expuestas si las
 *    puede consultar via `/api/tools/all`.
 */
export default function DevicesPanel({ accessToken }) {
  const [mcps, setMcps] = useState(null);
  const [tools, setTools] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const setSection = useUIStore((s) => s.setSection);
  const openNew = useUIStore((s) => s.setSection); // chat

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const mRes = await fetch(`${API_BASE}/api/mcps`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!mRes.ok) throw new Error(`MCPs: HTTP ${mRes.status}`);
      const mData = await mRes.json();
      setMcps(Array.isArray(mData) ? mData : []);

      // tools-all (existe bajo /api/tools — expone all tools agregadas)
      try {
        const tRes = await fetch(`${API_BASE}/api/tools/all`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (tRes.ok) setTools(await tRes.json());
      } catch { /* tools filter puede no estar disponible */ }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (accessToken) load(); }, [accessToken]);

  const haMcp = useMemo(() => {
    if (!mcps) return null;
    return mcps.find(m => /home.?assist|^ha$|homeass/i.test(m.name || ''));
  }, [mcps]);

  const haTools = useMemo(() => {
    if (!tools || !Array.isArray(tools)) return [];
    return tools.filter(t => {
      const n = (t.name || '').toLowerCase();
      const src = (t.source || t.mcp || '').toLowerCase();
      return /ha_|hass|home.?assist/.test(n) || /home.?assist|^ha$/i.test(src);
    });
  }, [tools]);

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title}>
            <Home size={20} aria-hidden="true" /> Dispositivos
          </h2>
          <p className={styles.subtitle}>
            Controla luces, termostatos, sensores y más vía Home Assistant.
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

      {!loading && !haMcp && (
        <section className={styles.setupCard}>
          <div className={styles.setupHead}>
            <span className={styles.setupBadge}>No configurado</span>
            <h3>Conectá Home Assistant</h3>
          </div>
          <p className={styles.setupDesc}>
            Clawmint controla dispositivos a través de un MCP server que se comunica con tu instancia de Home Assistant.
          </p>
          <ol className={styles.steps}>
            <li>
              <strong>Obtené un token de HA</strong>:
              en tu HA → <em>Tu perfil</em> → <em>Tokens de acceso de larga duración</em> → <em>Crear token</em>.
            </li>
            <li>
              <strong>Agregá el MCP</strong>: en el tab <em>MCPs</em>, clic <em>Add MCP</em> y usá:
              <pre className={styles.code}>{`{
  "name": "homeassistant",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-homeassistant"],
  "env": {
    "HA_URL": "http://tu-ha:8123",
    "HA_TOKEN": "<token-creado-arriba>"
  }
}`}</pre>
            </li>
            <li>
              <strong>Habilitá el MCP</strong> con el toggle y sincronizá. Listo — el agente podrá controlar dispositivos.
            </li>
          </ol>
          <div className={styles.setupActions}>
            <button className={styles.btnPrimary} onClick={() => setSection('config', { configTab: 'mcps' })}>
              <Plus size={14} /> Ir a MCPs
            </button>
            <a
              className={styles.btnGhost}
              href="https://www.home-assistant.io/docs/authentication/#your-account-profile"
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={12} /> Docs HA
            </a>
          </div>
        </section>
      )}

      {!loading && haMcp && (
        <section className={styles.connectedCard}>
          <div className={styles.connectedHead}>
            <span className={styles.setupBadge} data-ok>Conectado</span>
            <h3>Home Assistant</h3>
            <div className={styles.mcpInfo}>
              MCP: <code>{haMcp.name}</code> {haMcp.enabled === false && <span className={styles.tag}>disabled</span>}
            </div>
          </div>
          <p className={styles.connectedDesc}>
            El agente tiene acceso a {haTools.length || '¿?'} herramientas de HA. Controla dispositivos desde el chat con lenguaje natural.
          </p>

          <div className={styles.exampleGrid}>
            <ExampleCard Icon={Lightbulb}    label="Luces"      example="Apagá las luces del living" />
            <ExampleCard Icon={Thermometer}  label="Clima"      example="Bajá el termostato a 22°" />
            <ExampleCard Icon={Radio}        label="Media"      example="Pausá el Chromecast" />
            <ExampleCard Icon={Wifi}         label="Sensores"   example="¿Qué temperatura hay en el dormitorio?" />
          </div>

          <div className={styles.connectedActions}>
            <button className={styles.btnPrimary} onClick={() => setSection('chat')}>
              <MessageSquare size={14} /> Abrir Chat
            </button>
            <button className={styles.btnGhost} onClick={() => setSection('config', { configTab: 'mcps' })}>
              Configurar MCP <ExternalLink size={12} />
            </button>
          </div>

          {haTools.length > 0 && (
            <details className={styles.toolsDetails}>
              <summary>{haTools.length} herramienta(s) disponibles</summary>
              <ul className={styles.toolList}>
                {haTools.slice(0, 24).map(t => (
                  <li key={t.name}><code>{t.name}</code>{t.description && <span> — {t.description}</span>}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
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
