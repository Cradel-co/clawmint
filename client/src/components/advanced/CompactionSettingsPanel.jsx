import { useEffect, useState } from 'react';
import { config as api } from '../../api/advanced';
import styles from '../admin/AdminPanel.module.css';

/**
 * CompactionSettingsPanel (Fase E.1) — editor de flags de compactación de
 * contexto. Los valores se persisten en `chat_settings` global y se aplican
 * en runtime sin restart.
 */
export default function CompactionSettingsPanel({ accessToken }) {
  const [state, setState] = useState(null);
  const [form, setForm] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const data = await api.compaction.get(accessToken);
      setState(data);
      setForm({ ...(data.current || {}) });
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [accessToken]);

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      await api.compaction.set(accessToken, form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!state) {
    return <div className={styles.root}><div className={styles.empty}>Cargando…</div></div>;
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Context compaction</h1>
          <p className={styles.subtitle}>
            Estrategias de compactación del history para no superar el context window.
            Los cambios aplican en runtime (no requieren restart).
            {state.overridden && ' · '}
            {state.overridden && <span className={styles.tag}>custom</span>}
          </p>
        </div>
        <div className={styles.actions}>
          {saved && <span className={styles.tag + ' ' + styles.tagSuccess}>guardado</span>}
          <button className={styles.btn} onClick={load}>Reload</button>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Toggles</h2>
        <div className={styles.formRow}>
          <ToggleField label="Reactive compactor" hint="Compacta cuando detecta overflow de tokens" value={form.reactive_enabled} onChange={v => setField('reactive_enabled', v)} />
          <ToggleField label="Micro compactor" hint="Resumen pequeño cada N turnos" value={form.micro_enabled} onChange={v => setField('micro_enabled', v)} />
        </div>
      </section>

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Tuning</h2>
        <div className={styles.formRow}>
          <NumField label="Microcompact every turns" value={form.microcompact_every_turns} onChange={v => setField('microcompact_every_turns', v)} min={1} max={100} />
          <NumField label="Microcompact keep last K" value={form.microcompact_keep_last_k} onChange={v => setField('microcompact_keep_last_k', v)} min={0} max={20} />
          <NumField label="Autocompact buffer tokens" value={form.autocompact_buffer_tokens} onChange={v => setField('autocompact_buffer_tokens', v)} min={1000} max={200000} step={1000} />
          <NumField label="Max consecutive compact failures" value={form.max_consecutive_compact_failures} onChange={v => setField('max_consecutive_compact_failures', v)} min={1} max={10} />
        </div>
      </section>

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Defaults (env)</h2>
        <pre className={styles.mono} style={{ background: 'var(--oc2-surface-base)', padding: 12, borderRadius: 6, fontSize: 11 }}>
          {JSON.stringify(state.defaults, null, 2)}
        </pre>
      </section>
    </div>
  );
}

function ToggleField({ label, hint, value, onChange }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
        <span style={{ fontSize: 12, color: 'var(--oc2-text-weak)' }}>{hint}</span>
      </label>
    </div>
  );
}

function NumField({ label, value, onChange, min, max, step = 1 }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <input className={styles.input} type="number" min={min} max={max} step={step} value={value ?? ''} onChange={e => onChange(Number(e.target.value))} />
    </div>
  );
}
