import { useEffect, useState } from 'react';
import { permissions as api } from '../../api/admin';
import styles from './AdminPanel.module.css';

const SCOPES = ['global', 'role', 'channel', 'user', 'chat'];
const ACTIONS = ['auto', 'ask', 'deny'];

/**
 * PermissionsPanel — CRUD visual de reglas RBAC.
 *
 * Requiere rol admin. El server chequea `PERMISSIONS_ENABLED=true` antes de
 * aplicar las reglas; acá mostramos el status y advertimos si está off.
 */
export default function PermissionsPanel({ accessToken }) {
  const [rules, setRules] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ scope_type: 'global', scope_id: '', tool_pattern: '*', action: 'auto', reason: '' });
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [list, st] = await Promise.all([
        api.list(accessToken),
        api.status(accessToken).catch(() => null),
      ]);
      setRules(list || []);
      setStatus(st);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => { load(); }, [accessToken]);

  const create = async (e) => {
    e.preventDefault();
    if (!form.tool_pattern.trim()) return setError('tool_pattern requerido');
    setSubmitting(true);
    setError(null);
    try {
      await api.create(accessToken, {
        scope_type: form.scope_type,
        scope_id: form.scope_type === 'global' ? null : form.scope_id,
        tool_pattern: form.tool_pattern.trim(),
        action: form.action,
        reason: form.reason || null,
      });
      setForm({ scope_type: 'global', scope_id: '', tool_pattern: '*', action: 'auto', reason: '' });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id) => {
    if (!confirm('¿Eliminar esta regla?')) return;
    try { await api.remove(accessToken, id); await load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Permisos (RBAC)</h1>
          <p className={styles.subtitle}>
            Reglas que controlan qué tools puede ejecutar el agente por chat / user / role / channel / global.
            {status && (
              <>
                {' · '}
                <span className={`${styles.tag} ${status.enabled ? styles.tagSuccess : styles.tagWarning}`}>
                  {status.enabled ? 'activo' : 'desactivado (PERMISSIONS_ENABLED=false)'}
                </span>
              </>
            )}
          </p>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Nueva regla</h2>
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
                <input className={styles.input} value={form.scope_id} onChange={e => setForm({ ...form, scope_id: e.target.value })} placeholder={placeholderFor(form.scope_type)} />
              </div>
            )}
            <div className={styles.field}>
              <label className={styles.label}>Tool pattern</label>
              <input className={styles.input} value={form.tool_pattern} onChange={e => setForm({ ...form, tool_pattern: e.target.value })} placeholder="bash / pty_* / memory_*" />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Acción</label>
              <select className={styles.select} value={form.action} onChange={e => setForm({ ...form, action: e.target.value })}>
                {ACTIONS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>
          <div className={styles.field} style={{ marginBottom: 12 }}>
            <label className={styles.label}>Razón (opcional)</label>
            <input className={styles.input} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="Justificación de la regla para auditoría" />
          </div>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={submitting}>
            {submitting ? 'Creando...' : 'Crear regla'}
          </button>
        </form>
      </section>

      <section className={styles.card}>
        <h2 style={{ fontSize: 14, fontWeight: 500, margin: 0, marginBottom: 12, color: 'var(--oc2-text-strong)' }}>Reglas existentes ({rules?.length ?? 0})</h2>
        {rules === null ? (
          <div className={styles.empty}>Cargando…</div>
        ) : rules.length === 0 ? (
          <div className={styles.empty}>Sin reglas. Default policy: <code>auto</code></div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Scope</th>
                <th>ID</th>
                <th>Tool pattern</th>
                <th>Acción</th>
                <th>Razón</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.id}>
                  <td><span className={styles.tag}>{r.scope_type}</span></td>
                  <td className={styles.mono}>{r.scope_id || '—'}</td>
                  <td className={styles.mono}>{r.tool_pattern}</td>
                  <td>
                    <span className={`${styles.tag} ${actionTagClass(r.action)}`}>{r.action}</span>
                  </td>
                  <td>{r.reason || <span style={{ opacity: 0.5 }}>—</span>}</td>
                  <td>
                    <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => remove(r.id)}>
                      Eliminar
                    </button>
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

function placeholderFor(scope) {
  return {
    user:    'user id (ej. u_abc123)',
    chat:    'chat id (ej. telegram:123456)',
    role:    'admin / user',
    channel: 'telegram / webchat / p2p',
  }[scope] || '';
}

function actionTagClass(a) {
  if (a === 'deny') return styles.tagError;
  if (a === 'ask')  return styles.tagWarning;
  return styles.tagSuccess;
}
