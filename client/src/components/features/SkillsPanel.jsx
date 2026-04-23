import { useEffect, useState } from 'react';
import { skills as api } from '../../api/features';
import styles from '../admin/AdminPanel.module.css';

/**
 * SkillsPanel (Fase C.5) — listar locales + search registry + install/uninstall.
 * Las skills viven en memory/<scope>/skills/<slug>/SKILL.md y se invocan con
 * /<slug> en cualquier chat (via Fase 11.2 slashCommandParser).
 */
export default function SkillsPanel({ accessToken }) {
  const [tab, setTab] = useState('installed');
  const [installed, setInstalled] = useState(null);
  const [searchResults, setSearchResults] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const loadInstalled = async () => {
    setError(null);
    try { setInstalled(await api.list(accessToken) || []); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => { if (tab === 'installed') loadInstalled(); }, [tab, accessToken]);

  const search = async () => {
    if (!query.trim()) return;
    setError(null);
    try { setSearchResults(await api.search(accessToken, query.trim()) || []); }
    catch (e) { setError(e.message); }
  };

  const install = async (skill) => {
    setBusy(skill.slug || skill.name);
    try { await api.install(accessToken, skill); await loadInstalled(); setTab('installed'); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  const uninstall = async (slug) => {
    if (!confirm(`¿Desinstalar skill "${slug}"?`)) return;
    setBusy(slug);
    try { await api.remove(accessToken, slug); await loadInstalled(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Skills</h1>
          <p className={styles.subtitle}>Skills reutilizables invocables con <code>/slug</code> desde cualquier chat.</p>
        </div>
        <div className={styles.actions}>
          <button className={`${styles.btn} ${tab === 'installed' ? styles.btnPrimary : ''}`} onClick={() => setTab('installed')}>Instaladas</button>
          <button className={`${styles.btn} ${tab === 'search' ? styles.btnPrimary : ''}`} onClick={() => setTab('search')}>Buscar registry</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {tab === 'installed' && (
        <section className={styles.card}>
          {installed === null ? <div className={styles.empty}>Cargando…</div> : installed.length === 0 ? (
            <div className={styles.empty}>Sin skills instaladas.</div>
          ) : (
            <table className={styles.table}>
              <thead><tr><th>Slug</th><th>Nombre</th><th>Descripción</th><th>Scope</th><th></th></tr></thead>
              <tbody>
                {installed.map(s => (
                  <tr key={s.slug || s.name}>
                    <td className={styles.mono}>/{s.slug || s.name}</td>
                    <td>{s.name}</td>
                    <td style={{ maxWidth: 400 }}>{s.description || '—'}</td>
                    <td><span className={styles.tag}>{s.scope || 'global'}</span></td>
                    <td>
                      <button className={`${styles.btn} ${styles.btnDanger}`} disabled={busy === (s.slug || s.name)} onClick={() => uninstall(s.slug || s.name)}>
                        Desinstalar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'search' && (
        <>
          <section className={styles.card}>
            <form onSubmit={e => { e.preventDefault(); search(); }} style={{ display: 'flex', gap: 8 }}>
              <input
                className={styles.input}
                placeholder="Buscar skills en el registry…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
              <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`}>Buscar</button>
            </form>
          </section>

          {searchResults !== null && (
            <section className={styles.card}>
              {searchResults.length === 0 ? (
                <div className={styles.empty}>Sin resultados.</div>
              ) : (
                <table className={styles.table}>
                  <thead><tr><th>Slug</th><th>Nombre</th><th>Descripción</th><th></th></tr></thead>
                  <tbody>
                    {searchResults.map(s => (
                      <tr key={s.slug || s.name}>
                        <td className={styles.mono}>/{s.slug || s.name}</td>
                        <td>{s.name}</td>
                        <td style={{ maxWidth: 400 }}>{s.description || '—'}</td>
                        <td>
                          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy === (s.slug || s.name)} onClick={() => install(s)}>
                            Instalar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
