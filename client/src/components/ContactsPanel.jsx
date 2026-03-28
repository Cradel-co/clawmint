import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Plus, Star, StarOff, Pencil, Trash2, Check, Phone, Mail,
  MessageSquare, Search, Users, LinkIcon,
  Unlink, ChevronDown, ChevronRight, ArrowLeft, UserPlus
} from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import './ContactsPanel.css';

const API = `${API_BASE}/api/contacts`;

// 8 colores para avatares (hash del nombre)
const AVATAR_COLORS = [
  ['#a78bfa', '#7c3aed'], // purple
  ['#4fc3f7', '#2196f3'], // blue
  ['#4ade80', '#16a34a'], // green
  ['#fbbf24', '#d97706'], // amber
  ['#f87171', '#dc2626'], // red
  ['#fb923c', '#ea580c'], // orange
  ['#2dd4bf', '#0d9488'], // teal
  ['#f472b6', '#db2777'], // pink
];

function hashName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return Math.abs(h) % AVATAR_COLORS.length;
}

function Avatar({ name, size = 36, className = '' }) {
  const [c1, c2] = AVATAR_COLORS[hashName(name || '?')];
  return (
    <div
      className={`cp-avatar ${className}`}
      style={{
        width: size, height: size, minWidth: size,
        background: `linear-gradient(135deg, ${c1}, ${c2})`,
        fontSize: Math.round(size * 0.38),
      }}
    >
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

/* ─── Formulario ─── */
function ContactForm({ initial, onSave, onCancel }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || '');
  const [phone, setPhone] = useState(initial?.phone || '');
  const [email, setEmail] = useState(initial?.email || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [isFavorite, setIsFavorite] = useState(!!initial?.is_favorite);
  const [telegramId, setTelegramId] = useState(
    initial?.linkedUser?.identities?.find(i => i.channel === 'telegram')?.identifier || ''
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const handleSubmit = async () => {
    setError('');
    if (!name.trim()) { setError('El nombre es obligatorio'); return; }
    setLoading(true);
    try {
      const url = isEdit ? `${API}/${initial.id}` : API;
      const method = isEdit ? 'PATCH' : 'POST';
      const body = {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
        is_favorite: isFavorite,
      };
      if (!isEdit && telegramId.trim()) {
        const tid = telegramId.trim();
        if (tid.startsWith('@')) body.username = tid;
        else body.telegram_id = tid;
      }
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');

      const originalTid = initial?.linkedUser?.identities?.find(i => i.channel === 'telegram')?.identifier || '';
      if (isEdit && telegramId.trim() && telegramId.trim() !== originalTid) {
        const tid = telegramId.trim();
        const linkBody = tid.startsWith('@') ? { username: tid } : { telegram_id: tid };
        const linkRes = await apiFetch(`${API}/${initial.id}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(linkBody),
        });
        const linkData = await linkRes.json();
        if (!linkRes.ok || linkData.error) throw new Error(linkData.error || 'Error al vincular Telegram');
      }

      onSave();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="cp-form">
      <div className="cp-form-header">
        <button className="cp-back-btn" onClick={onCancel} aria-label="Cancelar">
          <ArrowLeft size={16} />
        </button>
        <span className="cp-form-title">{isEdit ? 'Editar contacto' : 'Nuevo contacto'}</span>
      </div>

      <div className="cp-form-body">
        <div className="cp-form-avatar-row">
          <Avatar name={name || '?'} size={56} />
          <div className="cp-form-avatar-hint">
            {name.trim() || 'Nuevo contacto'}
          </div>
        </div>

        <div className="cp-field">
          <label className="cp-label">Nombre *</label>
          <input ref={nameRef} className="cp-input" type="text" placeholder="Juan García"
            value={name} onChange={e => { setName(e.target.value); setError(''); }} />
        </div>

        <div className="cp-fields-row">
          <div className="cp-field" style={{ flex: 1 }}>
            <label className="cp-label">Teléfono</label>
            <input className="cp-input" type="tel" placeholder="+54 11 1234-5678"
              value={phone} onChange={e => setPhone(e.target.value)} />
          </div>
          <div className="cp-field" style={{ flex: 1 }}>
            <label className="cp-label">Email</label>
            <input className="cp-input" type="email" placeholder="juan@ejemplo.com"
              value={email} onChange={e => setEmail(e.target.value)} />
          </div>
        </div>

        <div className="cp-field">
          <label className="cp-label">Telegram (ID o @username)</label>
          <input className="cp-input" type="text" placeholder="ej: 7874537448 o @usuario"
            value={telegramId} onChange={e => setTelegramId(e.target.value)} />
        </div>

        <div className="cp-field">
          <label className="cp-label">Notas</label>
          <textarea className="cp-textarea" rows={3} placeholder="Notas sobre este contacto..."
            value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        <label className="cp-checkbox-row">
          <input type="checkbox" checked={isFavorite} onChange={e => setIsFavorite(e.target.checked)} />
          <Star size={13} className={isFavorite ? 'cp-star-on' : ''} />
          <span>Favorito</span>
        </label>

        {error && <p className="cp-error">{error}</p>}

        <div className="cp-btn-row">
          <button className="cp-btn cp-btn-primary" onClick={handleSubmit} disabled={loading || !name.trim()}>
            {loading ? '...' : <><Check size={13} /> {isEdit ? 'Guardar' : 'Crear'}</>}
          </button>
          <button className="cp-btn cp-btn-ghost" onClick={onCancel}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Detalle ─── */
function ContactDetail({ contactId, onBack, onEdit, onDelete }) {
  const [contact, setContact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sectionsOpen, setSectionsOpen] = useState({ info: true, telegram: true, notes: true });

  useEffect(() => {
    setLoading(true);
    apiFetch(`${API}/${contactId}`)
      .then(r => r.json())
      .then(data => { setContact(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [contactId]);

  const toggle = key => setSectionsOpen(s => ({ ...s, [key]: !s[key] }));

  if (loading) return <div className="cp-detail-empty"><div className="cp-spinner" /></div>;
  if (!contact) return <div className="cp-detail-empty">Contacto no encontrado</div>;

  const tgIdentity = contact.linkedUser?.identities?.find(i => i.channel === 'telegram');

  return (
    <div className="cp-detail">
      <div className="cp-detail-top">
        <button className="cp-back-btn cp-detail-back-mobile" onClick={onBack} aria-label="Volver">
          <ArrowLeft size={16} />
        </button>
        <Avatar name={contact.name} size={64} className="cp-detail-avatar" />
        <h2 className="cp-detail-name">
          {contact.name}
          {contact.is_favorite && <Star size={14} className="cp-star-icon" />}
        </h2>
        {(contact.phone || contact.email) && (
          <p className="cp-detail-subtitle">
            {[contact.phone, contact.email].filter(Boolean).join(' · ')}
          </p>
        )}
        <div className="cp-detail-toolbar">
          <button className="cp-action-btn" onClick={() => onEdit(contact)}>
            <Pencil size={14} /> Editar
          </button>
          <button className="cp-action-btn cp-action-btn-danger" onClick={() => onDelete(contact)}>
            <Trash2 size={14} /> Eliminar
          </button>
        </div>
      </div>

      <div className="cp-detail-body">
        {/* Sección Info */}
        <div className="cp-section">
          <button className="cp-section-header" onClick={() => toggle('info')}>
            {sectionsOpen.info ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Información</span>
          </button>
          {sectionsOpen.info && (
            <div className="cp-section-content">
              {contact.phone && (
                <div className="cp-info-row">
                  <Phone size={14} className="cp-info-icon" />
                  <div>
                    <div className="cp-info-label">Teléfono</div>
                    <div className="cp-info-value">{contact.phone}</div>
                  </div>
                </div>
              )}
              {contact.email && (
                <div className="cp-info-row">
                  <Mail size={14} className="cp-info-icon" />
                  <div>
                    <div className="cp-info-label">Email</div>
                    <div className="cp-info-value">{contact.email}</div>
                  </div>
                </div>
              )}
              {!contact.phone && !contact.email && (
                <p className="cp-info-empty">Sin información de contacto</p>
              )}
            </div>
          )}
        </div>

        {/* Sección Telegram */}
        <div className="cp-section">
          <button className="cp-section-header" onClick={() => toggle('telegram')}>
            {sectionsOpen.telegram ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Telegram</span>
            {contact.linkedUser && <span className="cp-badge-linked-sm">vinculado</span>}
          </button>
          {sectionsOpen.telegram && (
            <div className="cp-section-content">
              {contact.linkedUser ? (
                <>
                  <div className="cp-info-row">
                    <LinkIcon size={14} className="cp-info-icon cp-info-icon-linked" />
                    <div>
                      <div className="cp-info-label">Usuario vinculado</div>
                      <div className="cp-info-value">{contact.linkedUser.name}</div>
                    </div>
                  </div>
                  {tgIdentity && (
                    <div className="cp-info-row">
                      <MessageSquare size={14} className="cp-info-icon" />
                      <div>
                        <div className="cp-info-label">Telegram ID</div>
                        <div className="cp-info-value">{tgIdentity.identifier}</div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="cp-info-row cp-info-row-muted">
                  <Unlink size={14} className="cp-info-icon" />
                  <span>Sin usuario vinculado</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sección Notas */}
        {contact.notes && (
          <div className="cp-section">
            <button className="cp-section-header" onClick={() => toggle('notes')}>
              {sectionsOpen.notes ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span>Notas</span>
            </button>
            {sectionsOpen.notes && (
              <div className="cp-section-content">
                <p className="cp-notes-text">{contact.notes}</p>
              </div>
            )}
          </div>
        )}

        <div className="cp-detail-id">ID: {contact.id}</div>
      </div>
    </div>
  );
}

/* ─── Fila de contacto ─── */
function ContactRow({ contact, isActive, onSelect, onToggleFav }) {
  return (
    <div
      className={`cp-row ${isActive ? 'cp-row-active' : ''}`}
      onClick={() => onSelect(contact.id)}
      role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onSelect(contact.id)}
    >
      <Avatar name={contact.name} size={36} />
      <div className="cp-row-info">
        <div className="cp-row-name">
          {contact.name}
          {contact.user_id && <span className="cp-badge-linked" title="Vinculado">🔗</span>}
        </div>
        <div className="cp-row-sub">
          {[contact.phone, contact.email].filter(Boolean).join(' · ') || 'Sin datos'}
        </div>
      </div>
      <button
        className={`cp-fav-btn ${contact.is_favorite ? 'cp-fav-active' : ''}`}
        onClick={e => { e.stopPropagation(); onToggleFav(contact); }}
        aria-label={contact.is_favorite ? 'Quitar favorito' : 'Marcar favorito'}
      >
        {contact.is_favorite ? <Star size={13} /> : <StarOff size={13} />}
      </button>
    </div>
  );
}

/* ─── Panel principal ─── */
export default function ContactsPanel({ onClose, embedded }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | 'fav' | 'linked' | 'unlinked'
  const [view, setView] = useState('list');    // 'list' | 'new' | 'edit'
  const [selected, setSelected] = useState(null);
  const [editContact, setEditContact] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (filter === 'fav') params.set('favorites', 'true');
      const res = await apiFetch(`${API}?${params}`);
      const data = await res.json();
      let list = Array.isArray(data) ? data : [];
      if (filter === 'linked') list = list.filter(c => c.user_id);
      if (filter === 'unlinked') list = list.filter(c => !c.user_id);
      setContacts(list);
    } catch {
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [query, filter]);

  useEffect(() => { load(); }, [load]);

  // Agrupar por letra inicial
  const grouped = useMemo(() => {
    const sorted = [...contacts].sort((a, b) => a.name.localeCompare(b.name));
    const groups = {};
    for (const c of sorted) {
      const letter = (c.name[0] || '#').toUpperCase();
      const key = /[A-ZÀ-Ú]/.test(letter) ? letter : '#';
      (groups[key] = groups[key] || []).push(c);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [contacts]);

  const handleToggleFav = async (contact) => {
    await apiFetch(`${API}/${contact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_favorite: !contact.is_favorite }),
    });
    load();
  };

  const handleDelete = async (contact) => {
    if (!confirm(`¿Eliminar "${contact.name}"?`)) return;
    await apiFetch(`${API}/${contact.id}`, { method: 'DELETE' });
    if (selected === contact.id) setSelected(null);
    load();
  };

  const handleSaved = () => {
    setView('list');
    setEditContact(null);
    load();
  };

  const filterButtons = [
    { key: 'all', label: 'Todos', Icon: Users },
    { key: 'fav', label: 'Favoritos', Icon: Star },
    { key: 'linked', label: 'Vinculados', Icon: LinkIcon },
    { key: 'unlinked', label: 'Sin vincular', Icon: Unlink },
  ];

  const showDetail = selected && view === 'list';
  const showForm = view === 'new' || view === 'edit';

  return (
    <div className="cp-panel" role="region" aria-label="Contactos">
      {/* ─── Sidebar: lista ─── */}
      <div className={`cp-sidebar ${showDetail || showForm ? 'cp-sidebar-has-detail' : ''}`}>
        <div className="cp-sidebar-header">
          <div className="cp-search-box">
            <Search size={14} className="cp-search-icon" />
            <input
              className="cp-search"
              type="search"
              placeholder="Buscar contactos..."
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <button
            className="cp-btn cp-btn-primary cp-btn-icon"
            onClick={() => { setView('new'); setEditContact(null); }}
            aria-label="Nuevo contacto"
            title="Nuevo contacto"
          >
            <UserPlus size={15} />
          </button>
        </div>

        <div className="cp-filters">
          {filterButtons.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`cp-filter-btn ${filter === key ? 'cp-filter-active' : ''}`}
              onClick={() => setFilter(key)}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>

        <div className="cp-list">
          {loading && <div className="cp-empty"><div className="cp-spinner" /></div>}
          {!loading && contacts.length === 0 && (
            <div className="cp-empty-state">
              <Users size={40} className="cp-empty-icon" />
              <p className="cp-empty-title">
                {query ? 'Sin resultados' : filter !== 'all' ? 'Sin contactos en este filtro' : 'Sin contactos'}
              </p>
              {!query && filter === 'all' && (
                <button className="cp-btn cp-btn-primary cp-btn-sm" onClick={() => setView('new')}>
                  <Plus size={13} /> Agregar contacto
                </button>
              )}
            </div>
          )}
          {!loading && grouped.map(([letter, items]) => (
            <div key={letter} className="cp-group">
              <div className="cp-group-letter">{letter}</div>
              {items.map(c => (
                <ContactRow
                  key={c.id}
                  contact={c}
                  isActive={selected === c.id}
                  onSelect={id => { setSelected(id); setView('list'); }}
                  onToggleFav={handleToggleFav}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="cp-sidebar-footer">
          <span className="cp-count">{contacts.length} contacto{contacts.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* ─── Main: detalle o formulario ─── */}
      <div className={`cp-main ${showDetail || showForm ? 'cp-main-visible' : ''}`}>
        {showForm && (
          <ContactForm
            initial={view === 'edit' ? editContact : null}
            onSave={handleSaved}
            onCancel={() => { setEditContact(null); setView('list'); }}
          />
        )}
        {showDetail && (
          <ContactDetail
            contactId={selected}
            onBack={() => setSelected(null)}
            onEdit={c => { setEditContact(c); setView('edit'); }}
            onDelete={handleDelete}
          />
        )}
        {!showDetail && !showForm && (
          <div className="cp-main-empty">
            <Users size={48} className="cp-main-empty-icon" />
            <p>Seleccioná un contacto para ver sus detalles</p>
          </div>
        )}
      </div>
    </div>
  );
}
