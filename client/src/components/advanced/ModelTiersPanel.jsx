import { useEffect, useState } from 'react';
import { config as api } from '../../api/advanced';
import styles from '../admin/AdminPanel.module.css';

const TIERS = ['cheap', 'balanced', 'premium'];

/**
 * ModelTiersPanel (Fase E.2) — editor visual de MODEL_TIERS_JSON.
 * Matriz provider × tier. Valores default vienen del env; overrides se
 * persisten en `chat_settings` → `config:model-tiers`.
 */
export default function ModelTiersPanel({ accessToken }) {
  const [state, setState] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const data = await api.modelTiers.get(accessToken);
      setState(data);
      setForm(clone(data.current || {}));
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [accessToken]);

  const setCell = (provider, tier, value) => {
    setForm(f => ({
      ...f,
      [provider]: { ...(f[provider] || {}), [tier]: value || undefined },
    }));
  };

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      // Solo enviamos keys no vacías; el server hace merge deep con defaults.
      await api.modelTiers.set(accessToken, pruneEmpty(form));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const resetProvider = (provider) => {
    setForm(f => ({ ...f, [provider]: clone(state.defaults[provider] || {}) }));
  };

  if (!state) return <div className={styles.root}><div className={styles.empty}>Cargando…</div></div>;

  const providers = Object.keys(state.defaults);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Model tiers</h1>
          <p className={styles.subtitle}>
            Mapeo <code>provider × tier → modelo</code>. Usado por routing cheap/balanced/premium
            (Fase 7.5). Sobrescribe los defaults del env.
          </p>
        </div>
        <div className={styles.actions}>
          {saved && <span className={`${styles.tag} ${styles.tagSuccess}`}>guardado</span>}
          <button className={styles.btn} onClick={load}>Reload</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Provider</th>
              {TIERS.map(t => <th key={t} style={{ textTransform: 'capitalize' }}>{t}</th>)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {providers.map(p => (
              <tr key={p}>
                <td style={{ fontWeight: 500, textTransform: 'capitalize' }}>{p}</td>
                {TIERS.map(tier => {
                  const val = form[p]?.[tier] || '';
                  const def = state.defaults[p]?.[tier] || '';
                  const overridden = !!val && val !== def;
                  return (
                    <td key={tier}>
                      <input
                        className={styles.input}
                        value={val}
                        placeholder={def || '—'}
                        onChange={e => setCell(p, tier, e.target.value)}
                        style={overridden ? { borderColor: 'var(--oc2-interactive)' } : undefined}
                      />
                    </td>
                  );
                })}
                <td>
                  <button className={styles.btn} onClick={() => resetProvider(p)}>Reset</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function pruneEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = pruneEmpty(v);
      if (Object.keys(nested).length) out[k] = nested;
    } else if (v !== undefined && v !== '' && v !== null) {
      out[k] = v;
    }
  }
  return out;
}
