import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, Ban, RotateCcw, RefreshCw, Trash2, Users, UserPlus, Copy, Check, X } from 'lucide-react';
import { users as api, invitations as inviteApi } from '../../api/admin';
import styles from './AdminPanel.module.css';

/**
 * UsersPanel — admin-only.
 * Lista usuarios + status (active/pending/disabled) + role + acciones:
 *   - Aprobar (pending → active)
 *   - Rechazar (pending/active → disabled)
 *   - Reactivar (disabled → active)
 *   - Cambiar role (user ↔ admin)
 *   - Eliminar (hard delete)
 *
 * Filtros tab por status. Badge de count de pending.
 */
export default function UsersPanel({ accessToken, currentUserId }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy]   = useState(null);
  const [filter, setFilter] = useState('all'); // all | pending | active | disabled
  const [showInvite, setShowInvite] = useState(false);

  const load = async () => {
    setError(null);
    try { setItems(await api.list(accessToken) || []); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [accessToken]);

  const counts = useMemo(() => {
    const out = { all: 0, pending: 0, active: 0, disabled: 0 };
    for (const u of items || []) {
      out.all++;
      const s = u.status || 'active';
      if (out[s] !== undefined) out[s]++;
    }
    return out;
  }, [items]);

  const visible = useMemo(() => {
    if (!items) return [];
    if (filter === 'all') return items;
    return items.filter(u => (u.status || 'active') === filter);
  }, [items, filter]);

  const setRole = async (u, newRole) => {
    if (u.role === newRole) return;
    if (!confirm(`Cambiar role de ${u.name || u.email || u.id} a "${newRole}"?`)) return;
    setBusy(u.id);
    try { await api.updateRole(accessToken, u.id, newRole); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  const approve = async (u) => {
    setBusy(u.id);
    try { await api.approve(accessToken, u.id); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  const reject = async (u) => {
    if (u.id === currentUserId) return setError('No podés rechazarte a vos mismo');
    if (!confirm(`¿Deshabilitar a ${u.name || u.email || u.id}?`)) return;
    setBusy(u.id);
    try { await api.reject(accessToken, u.id); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  const reactivate = async (u) => {
    setBusy(u.id);
    try { await api.reactivate(accessToken, u.id); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  const del = async (u) => {
    if (u.id === currentUserId) return setError('No podés borrarte a vos mismo');
    if (!confirm(`¿Eliminar permanentemente ${u.name || u.email || u.id}? Irreversible.`)) return;
    setBusy(u.id);
    try { await api.remove(accessToken, u.id); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}><Users size={20} style={{ verticalAlign: -4, marginRight: 8 }} /> Usuarios</h1>
          <p className={styles.subtitle}>
            Cuentas, roles, status y identidades (Telegram, WebChat, OAuth).
            {counts.pending > 0 && <strong style={{ color: 'var(--accent-orange)', marginLeft: 8 }}>· {counts.pending} pendiente(s) de aprobación</strong>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setShowInvite(true)}>
            <UserPlus size={14} /> Invitar miembro
          </button>
          <button className={styles.btn} onClick={load}>
            <RefreshCw size={14} /> Refrescar
          </button>
        </div>
      </header>

      {showInvite && (
        <InviteModal accessToken={accessToken} onClose={() => setShowInvite(false)} onCreated={load} />
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {[
          { id: 'all',      label: 'Todos',         color: null },
          { id: 'pending',  label: 'Pendientes',    color: 'var(--accent-orange)' },
          { id: 'active',   label: 'Activos',       color: 'var(--accent-green)' },
          { id: 'disabled', label: 'Deshabilitados', color: 'var(--accent-red)' },
        ].map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`${styles.btn} ${filter === f.id ? styles.btnPrimary : ''}`}
            style={{ fontSize: 12, padding: '4px 12px' }}
          >
            {f.label} ({counts[f.id]})
          </button>
        ))}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.card}>
        {items === null ? <div className={styles.empty}>Cargando…</div> : visible.length === 0 ? (
          <div className={styles.empty}>{filter === 'all' ? 'Sin usuarios.' : `Sin usuarios ${filter}.`}</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Email</th>
                <th>Status</th>
                <th>Role</th>
                <th>Identidades</th>
                <th>Creado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(u => {
                const isMe = u.id === currentUserId;
                const status = u.status || 'active';
                return (
                  <tr key={u.id}>
                    <td>
                      {u.name || <span style={{ opacity: 0.5 }}>(sin nombre)</span>}
                      {isMe && <span className={styles.tag} style={{ marginLeft: 6 }}>tú</span>}
                    </td>
                    <td className={styles.mono}>{u.email || '—'}</td>
                    <td>
                      <StatusBadge status={status} />
                    </td>
                    <td>
                      <select
                        className={styles.select}
                        value={u.role || 'user'}
                        disabled={busy === u.id || status !== 'active'}
                        onChange={e => setRole(u, e.target.value)}
                        style={{ width: 100 }}
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>
                      {Array.isArray(u.identities) && u.identities.length > 0 ? (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {u.identities.map((id, i) => (
                            <span key={i} className={styles.tag} title={id.identifier}>
                              {id.channel}: {String(id.identifier).slice(0, 12)}
                            </span>
                          ))}
                        </div>
                      ) : <span style={{ opacity: 0.5 }}>—</span>}
                    </td>
                    <td className={styles.mono}>{formatDate(u.created_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {status === 'pending' && (
                          <>
                            <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy === u.id} onClick={() => approve(u)} title="Aprobar">
                              <CheckCircle2 size={12} /> Aprobar
                            </button>
                            <button className={`${styles.btn} ${styles.btnDanger}`} disabled={busy === u.id} onClick={() => reject(u)} title="Rechazar">
                              <Ban size={12} /> Rechazar
                            </button>
                          </>
                        )}
                        {status === 'active' && !isMe && (
                          <button className={`${styles.btn} ${styles.btnDanger}`} disabled={busy === u.id} onClick={() => reject(u)} title="Deshabilitar">
                            <Ban size={12} /> Deshabilitar
                          </button>
                        )}
                        {status === 'disabled' && (
                          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy === u.id} onClick={() => reactivate(u)} title="Reactivar">
                            <RotateCcw size={12} /> Reactivar
                          </button>
                        )}
                        <button className={`${styles.btn} ${styles.btnDanger}`} disabled={isMe || busy === u.id} onClick={() => del(u)} title="Eliminar permanentemente">
                          <Trash2 size={12} /> Borrar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    active:   { label: 'Activo',         icon: CheckCircle2, bg: 'rgba(16, 185, 129, 0.14)', color: 'var(--accent-green)',  border: 'rgba(16, 185, 129, 0.35)' },
    pending:  { label: 'Pendiente',      icon: Clock,        bg: 'rgba(249, 115, 22, 0.14)', color: 'var(--accent-orange)', border: 'rgba(249, 115, 22, 0.35)' },
    disabled: { label: 'Deshabilitado',  icon: Ban,          bg: 'rgba(239, 68, 68, 0.12)',  color: 'var(--accent-red)',    border: 'rgba(239, 68, 68, 0.32)' },
  };
  const m = map[status] || map.active;
  const Icon = m.icon;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 999,
      background: m.bg, color: m.color,
      border: `1px solid ${m.border}`,
      fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
    }}>
      <Icon size={11} /> {m.label}
    </span>
  );
}

function formatDate(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toISOString().slice(0, 10); } catch { return '—'; }
}

// ── InviteModal ────────────────────────────────────────────────────────────

function InviteModal({ accessToken, onClose, onCreated }) {
  const [familyRole, setFamilyRole] = useState('');
  const [ttlHours, setTtlHours]     = useState(24);
  const [creating, setCreating]     = useState(false);
  const [created, setCreated]       = useState(null);
  const [copied, setCopied]         = useState(false);
  const [error, setError]           = useState(null);
  const [list, setList]             = useState(null);

  // Cargar invitaciones existentes para el panel
  useEffect(() => {
    inviteApi.list(accessToken).then(setList).catch(() => setList([]));
  }, [accessToken]);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const inv = await inviteApi.create(accessToken, { ttlHours: Number(ttlHours), familyRole: familyRole.trim() || null });
      setCreated(inv);
      onCreated?.();
      // refrescar lista
      inviteApi.list(accessToken).then(setList).catch(() => {});
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (code) => {
    if (!confirm('¿Revocar esta invitación?')) return;
    try {
      await inviteApi.revoke(accessToken, code);
      const fresh = await inviteApi.list(accessToken);
      setList(fresh);
    } catch (e) { setError(e.message); }
  };

  const inviteUrl = created
    ? `${window.location.protocol}//${window.location.host}/?invite=${created.code}`
    : '';

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: '100%', maxWidth: 560, maxHeight: '85vh', overflow: 'auto',
        background: 'var(--bg-panel)', border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)', padding: 20,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            <UserPlus size={18} style={{ verticalAlign: -3, marginRight: 6, color: 'var(--accent-orange)' }} />
            Invitar miembro de la familia
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={18} />
          </button>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        {!created ? (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
              Generá un link de invitación. Quien lo use queda <strong style={{ color: 'var(--accent-green)' }}>activo automáticamente</strong> sin necesidad de que vos apruebes uno por uno.
            </p>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.04, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
              Rol familiar (opcional)
            </label>
            <input
              type="text"
              value={familyRole}
              onChange={e => setFamilyRole(e.target.value)}
              placeholder="ej: mamá, papá, hijo, abuela"
              style={{
                width: '100%', padding: '8px 10px', marginTop: 4, marginBottom: 12,
                background: 'var(--bg-input)', border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', fontSize: 13,
              }}
            />
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.04, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
              Validez (horas)
            </label>
            <select
              value={ttlHours}
              onChange={e => setTtlHours(e.target.value)}
              style={{
                width: '100%', padding: '8px 10px', marginTop: 4, marginBottom: 16,
                background: 'var(--bg-input)', border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', fontSize: 13,
              }}
            >
              <option value={1}>1 hora</option>
              <option value={6}>6 horas</option>
              <option value={24}>24 horas (default)</option>
              <option value={72}>3 días</option>
              <option value={168}>1 semana</option>
            </select>
            <button
              onClick={create}
              disabled={creating}
              className={`${styles.btn} ${styles.btnPrimary}`}
              style={{ width: '100%' }}
            >
              {creating ? 'Generando…' : 'Generar invitación'}
            </button>
          </>
        ) : (
          <>
            <div style={{
              padding: 14, background: 'rgba(16, 185, 129, 0.10)',
              border: '1px solid rgba(16, 185, 129, 0.30)', borderRadius: 'var(--radius-md)',
              marginBottom: 14,
            }}>
              <div style={{ fontSize: 13, color: 'var(--status-ok)', fontWeight: 700, marginBottom: 8 }}>
                ✓ Invitación creada {created.family_role ? `para ${created.family_role}` : ''}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 10 }}>
                Compartí este link. Vence: {new Date(created.expires_at).toLocaleString('es-ES')}.
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px',
                background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
              }}>
                <code style={{
                  flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-primary)',
                  wordBreak: 'break-all',
                }}>{inviteUrl}</code>
                <button onClick={copyUrl} className={styles.btn} style={{ flexShrink: 0 }}>
                  {copied ? <><Check size={12} /> Copiado</> : <><Copy size={12} /> Copiar</>}
                </button>
              </div>
            </div>
            <button onClick={() => { setCreated(null); setFamilyRole(''); }} className={styles.btn} style={{ width: '100%' }}>
              Generar otra invitación
            </button>
          </>
        )}

        {list && list.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.04, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
              Invitaciones existentes ({list.length})
            </div>
            <table className={styles.table} style={{ fontSize: 11.5 }}>
              <thead>
                <tr><th>Código</th><th>Rol familiar</th><th>Status</th><th>Vence</th><th></th></tr>
              </thead>
              <tbody>
                {list.slice(0, 10).map(inv => (
                  <tr key={inv.code}>
                    <td className={styles.mono}>{inv.code.slice(0, 12)}…</td>
                    <td>{inv.family_role || '—'}</td>
                    <td><InvStatusBadge status={inv.status} /></td>
                    <td className={styles.mono}>{formatDate(inv.expires_at)}</td>
                    <td>
                      {inv.status === 'valid' && (
                        <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => revoke(inv.code)} style={{ fontSize: 10 }}>
                          Revocar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function InvStatusBadge({ status }) {
  const map = {
    valid:   { label: 'Vigente',  bg: 'rgba(16, 185, 129, 0.14)', color: 'var(--accent-green)' },
    used:    { label: 'Usada',    bg: 'rgba(107, 107, 114, 0.14)', color: 'var(--text-muted)' },
    expired: { label: 'Vencida',  bg: 'rgba(245, 158, 11, 0.14)', color: 'var(--accent-yellow)' },
    revoked: { label: 'Revocada', bg: 'rgba(239, 68, 68, 0.12)',  color: 'var(--accent-red)' },
  };
  const m = map[status] || map.valid;
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, background: m.bg, color: m.color,
      fontSize: 10, fontWeight: 700, letterSpacing: 0.04, textTransform: 'uppercase',
    }}>{m.label}</span>
  );
}
