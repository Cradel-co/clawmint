import { useEffect, useState } from 'react';
import { tasks as api } from '../../api/features';
import styles from '../admin/AdminPanel.module.css';

const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled', 'blocked'];

/**
 * TasksPanel (Fase C.1) — CRUD de tareas scoped por chat_id.
 * El user selecciona el chat (o usa el chat activo) y listamos tasks de ahí.
 */
export default function TasksPanel({ accessToken, chatId = 'default' }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ status: '', chat_id: chatId });
  const [form, setForm] = useState({ title: '', description: '', agent_key: '' });

  const load = async () => {
    setError(null);
    try {
      const q = { chat_id: filter.chat_id };
      if (filter.status) q.status = filter.status;
      setItems(await api.list(accessToken, q) || []);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [accessToken, filter.chat_id, filter.status]);

  const create = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return setError('title requerido');
    try {
      await api.create(accessToken, {
        chat_id: filter.chat_id,
        title: form.title.trim(),
        description: form.description || null,
        agent_key: form.agent_key || null,
      });
      setForm({ title: '', description: '', agent_key: '' });
      await load();
    } catch (e) { setError(e.message); }
  };

  const setStatus = async (t, newStatus) => {
    try {
      await api.update(accessToken, t.id, { chat_id: filter.chat_id, status: newStatus });
      await load();
    } catch (e) { setError(e.message); }
  };

  const remove = async (t) => {
    if (!confirm(`Eliminar "${t.title}"?`)) return;
    try { await api.remove(accessToken, t.id, filter.chat_id); await load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Tasks</h1>
          <p className={styles.subtitle}>Gestor de tareas scoped por chat_id. Tasks creadas desde el agente aparecen acá.</p>
        </div>
        <div className={styles.actions}>
          <input className={styles.input} style={{ width: 180 }} value={filter.chat_id} onChange={e => setFilter({ ...filter, chat_id: e.target.value })} placeholder="chat_id" />
          <select className={styles.select} style={{ width: 140 }} value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
            <option value="">todos status</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className={styles.btn} onClick={load}>Refresh</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Nueva task</h2>
        <form onSubmit={create}>
          <div className={styles.formRow}>
            <div className={styles.field} style={{ gridColumn: '1 / 3' }}>
              <label className={styles.label}>Título</label>
              <input className={styles.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Agent (opcional)</label>
              <input className={styles.input} value={form.agent_key} onChange={e => setForm({ ...form, agent_key: e.target.value })} placeholder="claude" />
            </div>
          </div>
          <div className={styles.field} style={{ marginBottom: 12 }}>
            <label className={styles.label}>Descripción (opcional)</label>
            <textarea className={styles.textarea} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} />
          </div>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`}>Crear</button>
        </form>
      </section>

      <section className={styles.card}>
        {items === null ? <div className={styles.empty}>Cargando…</div> : items.length === 0 ? (
          <div className={styles.empty}>Sin tasks para chat <code>{filter.chat_id}</code>.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Título</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Creada</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(t => (
                <tr key={t.id}>
                  <td className={styles.mono}>#{t.id}</td>
                  <td>
                    <div>{t.title}</div>
                    {t.description && <div style={{ fontSize: 11, color: 'var(--oc2-text-weak)', marginTop: 2 }}>{t.description}</div>}
                  </td>
                  <td className={styles.mono}>{t.agent_key || '—'}</td>
                  <td>
                    <select className={styles.select} style={{ width: 130 }} value={t.status} onChange={e => setStatus(t, e.target.value)}>
                      {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className={styles.mono}>{formatAgo(t.created_at)}</td>
                  <td>
                    <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => remove(t)}>Eliminar</button>
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

function formatAgo(ms) {
  if (!ms) return '—';
  const age = Date.now() - ms;
  if (age < 60_000) return `${Math.round(age / 1000)}s`;
  if (age < 3_600_000) return `${Math.round(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.round(age / 3_600_000)}h`;
  return new Date(ms).toISOString().slice(0, 10);
}
