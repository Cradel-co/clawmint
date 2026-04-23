import { useEffect, useState } from 'react';
import { hooks as api } from '../../api/admin';
import styles from './AdminPanel.module.css';

const EVENTS = [
  'pre_tool_call', 'post_tool_call', 'pre_chat', 'post_chat',
  'chat.params', 'message.received', 'session.started', 'session.ended',
];
const TYPES = ['js', 'shell', 'http'];

/**
 * HooksPanel — CRUD de hooks JavaScript/shell/HTTP que se ejecutan en eventos.
 * Require HOOKS_ENABLED=true en el server. Los hooks built-in no-editables
 * aparecen con badge "built-in".
 */
export default function HooksPanel({ accessToken }) {
  const [items, setItems] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ event: 'pre_tool_call', type: 'js', handler: '', match: '', enabled: true });
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [list, st] = await Promise.all([
        api.list(accessToken),
        api.status(accessToken).catch(() => null),
      ]);
      setItems(list || []);
      setStatus(st);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [accessToken]);

  const create = async (e) => {
    e.preventDefault();
    if (!form.handler.trim()) return setError('handler/code/url requerido');
    setSubmitting(true); setError(null);
    try {
      let matchObj = {};
      if (form.match.trim()) {
        try { matchObj = JSON.parse(form.match); }
        catch { return setError('match debe ser JSON válido'); }
      }
      await api.create(accessToken, {
        event: form.event,
        type: form.type,
        handler: form.handler.trim(),
        match: matchObj,
        enabled: form.enabled,
      });
      setForm({ event: 'pre_tool_call', type: 'js', handler: '', match: '', enabled: true });
      await load();
    } catch (e) { setError(e.message); }
    finally { setSubmitting(false); }
  };

  const toggle = async (h) => {
    try { await api.update(accessToken, h.id, { enabled: !h.enabled }); await load(); }
    catch (e) { setError(e.message); }
  };

  const remove = async (id) => {
    if (!confirm('¿Eliminar este hook?')) return;
    try { await api.remove(accessToken, id); await load(); }
    catch (e) { setError(e.message); }
  };

  const reload = async () => {
    try { await api.reload(accessToken); await load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Hooks</h1>
          <p className={styles.subtitle}>
            Handlers JS/shell/HTTP ejecutados en eventos del server.
            {status && (
              <>
                {' · '}
                <span className={`${styles.tag} ${status.enabled ? styles.tagSuccess : styles.tagWarning}`}>
                  {status.enabled ? 'activo' : 'HOOKS_ENABLED=false'}
                </span>
              </>
            )}
          </p>
        </div>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={reload}>Reload</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Nuevo hook</h2>
        <form onSubmit={create}>
          <div className={styles.formRow}>
            <div className={styles.field}>
              <label className={styles.label}>Evento</label>
              <select className={styles.select} value={form.event} onChange={e => setForm({ ...form, event: e.target.value })}>
                {EVENTS.map(e => <option key={e} value={e}>{e}</option>)}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Tipo</label>
              <select className={styles.select} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
              <label className={styles.label}>Match (JSON, opcional)</label>
              <input className={styles.input} value={form.match} onChange={e => setForm({ ...form, match: e.target.value })} placeholder='{"tool":"bash"}' />
            </div>
          </div>
          <div className={styles.field} style={{ marginBottom: 12 }}>
            <label className={styles.label}>
              {form.type === 'js' ? 'Handler name (pre-registered en jsExecutor)' : form.type === 'shell' ? 'Shell command' : 'HTTP URL (POST)'}
            </label>
            <textarea className={styles.textarea} value={form.handler} onChange={e => setForm({ ...form, handler: e.target.value })} rows={form.type === 'shell' ? 3 : 2} />
          </div>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={submitting}>
            {submitting ? 'Creando...' : 'Crear hook'}
          </button>
        </form>
      </section>

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Hooks registrados ({items?.length ?? 0})</h2>
        {items === null ? <div className={styles.empty}>Cargando…</div> : items.length === 0 ? (
          <div className={styles.empty}>Sin hooks registrados.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Evento</th>
                <th>Tipo</th>
                <th>Handler / URL / Command</th>
                <th>Match</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(h => (
                <tr key={h.id}>
                  <td className={styles.mono}>{h.event}</td>
                  <td><span className={styles.tag}>{h.type}</span></td>
                  <td className={styles.mono} style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.handler}</td>
                  <td className={styles.mono}>{h.match && Object.keys(h.match || {}).length ? JSON.stringify(h.match) : '—'}</td>
                  <td>
                    <span className={`${styles.tag} ${h.enabled ? styles.tagSuccess : ''}`}>{h.enabled ? 'activo' : 'pausado'}</span>
                    {h.builtin && <span className={styles.tag} style={{ marginLeft: 4 }}>built-in</span>}
                  </td>
                  <td>
                    {!h.builtin && (
                      <>
                        <button className={styles.btn} onClick={() => toggle(h)}>{h.enabled ? 'Pausar' : 'Activar'}</button>
                        {' '}
                        <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => remove(h.id)}>Eliminar</button>
                      </>
                    )}
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
