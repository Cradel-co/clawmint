import { useEffect, useState } from 'react';
import { typedMemory as api } from '../../api/features';
import styles from '../admin/AdminPanel.module.css';

const KINDS = ['user', 'feedback', 'project', 'reference', 'freeform'];
const SCOPES = ['user', 'chat', 'agent', 'global'];

/**
 * TypedMemoryPanel (Fase C.3) — CRUD de memorias tipadas.
 * Complementa el MemoryPanel existente (archivos .md). Las typed memories
 * tienen schema: scope_type + scope_id + kind + name + body_path.
 */
export default function TypedMemoryPanel({ accessToken }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({ scope_type: '', kind: '', scope_id: '' });
  const [form, setForm] = useState({ scope_type: 'user', scope_id: '', kind: 'user', name: '', description: '', body_path: '' });

  const load = async () => {
    setError(null);
    try {
      const q = {};
      if (filter.scope_type) q.scope_type = filter.scope_type;
      if (filter.kind) q.kind = filter.kind;
      if (filter.scope_id) q.scope_id = filter.scope_id;
      setItems(await api.list(accessToken, q) || []);
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [accessToken, filter.scope_type, filter.kind, filter.scope_id]);

  const create = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.body_path.trim()) return setError('name y body_path requeridos');
    try {
      await api.create(accessToken, {
        scope_type: form.scope_type,
        scope_id: form.scope_id || null,
        kind: form.kind,
        name: form.name.trim(),
        description: form.description || null,
        body_path: form.body_path.trim(),
      });
      setForm({ scope_type: 'user', scope_id: '', kind: 'user', name: '', description: '', body_path: '' });
      await load();
    } catch (e) { setError(e.message); }
  };

  const remove = async (id) => {
    if (!confirm('¿Eliminar esta memoria tipada?')) return;
    try { await api.remove(accessToken, id); await load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Memorias tipadas</h1>
          <p className={styles.subtitle}>
            Indexadas por kind (user/feedback/project/reference/freeform) y scope (user/chat/agent/global).
            El body vive en disco en <code>{`memory/<scope>/<id>/<name>.md`}</code>.
          </p>
        </div>
        <div className={styles.actions}>
          <select className={styles.select} value={filter.scope_type} onChange={e => setFilter({ ...filter, scope_type: e.target.value })}>
            <option value="">scope: todos</option>
            {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className={styles.select} value={filter.kind} onChange={e => setFilter({ ...filter, kind: e.target.value })}>
            <option value="">kind: todos</option>
            {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          <input className={styles.input} style={{ width: 140 }} value={filter.scope_id} onChange={e => setFilter({ ...filter, scope_id: e.target.value })} placeholder="scope_id (opcional)" />
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Nueva memoria tipada</h2>
        <form onSubmit={create}>
          <div className={styles.formRow}>
            <div className={styles.field}>
              <label className={styles.label}>Scope</label>
              <select className={styles.select} value={form.scope_type} onChange={e => setForm({ ...form, scope_type: e.target.value })}>
                {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {form.scope_type !== 'global' && (
              <div className={styles.field}>
                <label className={styles.label}>Scope ID</label>
                <input className={styles.input} value={form.scope_id} onChange={e => setForm({ ...form, scope_id: e.target.value })} />
              </div>
            )}
            <div className={styles.field}>
              <label className={styles.label}>Kind</label>
              <select className={styles.select} value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}>
                {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Name</label>
              <input className={styles.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
            </div>
          </div>
          <div className={styles.field} style={{ marginBottom: 12 }}>
            <label className={styles.label}>Body path (relativo)</label>
            <input className={styles.input} value={form.body_path} onChange={e => setForm({ ...form, body_path: e.target.value })} placeholder="memory/user/u1/mi-pref.md" required />
          </div>
          <div className={styles.field} style={{ marginBottom: 12 }}>
            <label className={styles.label}>Descripción (opcional)</label>
            <input className={styles.input} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`}>Crear</button>
        </form>
      </section>

      <section className={styles.card}>
        {items === null ? <div className={styles.empty}>Cargando…</div> : items.length === 0 ? (
          <div className={styles.empty}>Sin memorias tipadas.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Scope</th><th>ID</th><th>Kind</th><th>Name</th><th>Path</th><th>Descripción</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map(m => (
                <tr key={m.id}>
                  <td><span className={styles.tag}>{m.scope_type}</span></td>
                  <td className={styles.mono}>{m.scope_id || '—'}</td>
                  <td><span className={styles.tag}>{m.kind}</span></td>
                  <td>{m.name}</td>
                  <td className={styles.mono} style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.body_path}</td>
                  <td>{m.description || <span style={{ opacity: 0.5 }}>—</span>}</td>
                  <td>
                    <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => remove(m.id)}>Eliminar</button>
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
