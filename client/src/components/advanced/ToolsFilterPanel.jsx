import { useEffect, useMemo, useState } from 'react';
import { toolsAdmin as api } from '../../api/advanced';
import styles from '../admin/AdminPanel.module.css';

/**
 * ToolsFilterPanel (Fase E.3) — lista completa de tools registradas + toggle
 * on/off individual. Los toggles se persisten en `chat_settings` (user_disabled).
 * env-disabled vía MCP_DISABLED_TOOLS es read-only.
 */
export default function ToolsFilterPanel({ accessToken }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ category: '', search: '', source: '' });
  const [busy, setBusy] = useState(null);

  const load = async () => {
    setError(null);
    try { setData(await api.list(accessToken)); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [accessToken]);

  const categories = useMemo(() => {
    if (!data) return [];
    const set = new Set(data.tools.map(t => t.category || 'other'));
    return Array.from(set).sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = filter.search.toLowerCase();
    return data.tools.filter(t => {
      if (filter.category && (t.category || 'other') !== filter.category) return false;
      if (filter.source && t.source !== filter.source) return false;
      if (q && !t.name.toLowerCase().includes(q) && !(t.description || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, filter]);

  const toggle = async (t) => {
    setBusy(t.name);
    try {
      await api.toggle(accessToken, t.name, !t.disabled_user);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  if (!data) return <div className={styles.root}><div className={styles.empty}>Cargando…</div></div>;

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Tools filter</h1>
          <p className={styles.subtitle}>
            {data.tools.length} tools registradas. Toggle individual persiste en <code>config:tools-disabled</code>.
            {data.env_disabled.length > 0 && ` · ${data.env_disabled.length} deshabilitadas por env (read-only).`}
          </p>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className={styles.input}
          placeholder="Buscar por nombre o descripción…"
          value={filter.search}
          onChange={e => setFilter({ ...filter, search: e.target.value })}
          style={{ maxWidth: 320 }}
        />
        <select className={styles.select} value={filter.category} onChange={e => setFilter({ ...filter, category: e.target.value })}>
          <option value="">categoría: todas</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className={styles.select} value={filter.source} onChange={e => setFilter({ ...filter, source: e.target.value })}>
          <option value="">source: todos</option>
          <option value="core">core</option>
          <option value="mcp">mcp externo</option>
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--oc2-text-weak)', alignSelf: 'center' }}>
          {filtered.length} / {data.tools.length}
        </span>
      </section>

      <section className={styles.card}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Categoría</th>
              <th>Source</th>
              <th>Flags</th>
              <th>Descripción</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <tr key={t.name}>
                <td className={styles.mono}>{t.name}</td>
                <td><span className={styles.tag}>{t.category || 'other'}</span></td>
                <td className={styles.mono}>{t.source}</td>
                <td>
                  {t.adminOnly && <span className={`${styles.tag} ${styles.tagWarning}`}>admin</span>}
                  {t.coordinatorOnly && <span className={`${styles.tag} ${styles.tagInfo}`} style={{ marginLeft: 4 }}>coord</span>}
                  {t.channel && <span className={styles.tag} style={{ marginLeft: 4 }}>{t.channel}</span>}
                  {t.disabled_env && <span className={`${styles.tag} ${styles.tagError}`} style={{ marginLeft: 4 }} title="MCP_DISABLED_TOOLS">env-off</span>}
                </td>
                <td style={{ maxWidth: 400, fontSize: 11, color: 'var(--oc2-text-weak)' }}>{t.description}</td>
                <td>
                  {t.disabled_env ? (
                    <span className={styles.tag}>env</span>
                  ) : (
                    <button
                      className={`${styles.btn} ${t.disabled_user ? styles.btnDanger : styles.btnPrimary}`}
                      disabled={busy === t.name}
                      onClick={() => toggle(t)}
                    >
                      {busy === t.name ? '…' : t.disabled_user ? 'off' : 'on'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
