import { useState, useEffect, useCallback } from 'react';
import { X, Plus, Star, StarOff, Pencil, Trash2, Check, Phone, Mail, FileText, Link, MessageSquare } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import './ContactsPanel.css';

const API = `${API_BASE}/api/contacts`;

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
      if (!isEdit && telegramId.trim()) body.telegram_id = telegramId.trim();
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');

      // En edición, vincular por Telegram ID si se proporcionó
      if (isEdit && telegramId.trim()) {
        const linkRes = await apiFetch(`${API}/${initial.id}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telegram_id: telegramId.trim() }),
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
      <p className="cp-form-title">{isEdit ? `Editar contacto` : 'Nuevo contacto'}</p>

      <label className="cp-label">Nombre *</label>
      <input
        className="cp-input"
        type="text"
        placeholder="Juan García"
        value={name}
        onChange={e => { setName(e.target.value); setError(''); }}
        aria-label="Nombre del contacto"
      />

      <label className="cp-label" style={{ marginTop: 8 }}>Teléfono</label>
      <input
        className="cp-input"
        type="tel"
        placeholder="+54 11 1234-5678"
        value={phone}
        onChange={e => setPhone(e.target.value)}
        aria-label="Teléfono"
      />

      <label className="cp-label" style={{ marginTop: 8 }}>Email</label>
      <input
        className="cp-input"
        type="email"
        placeholder="juan@ejemplo.com"
        value={email}
        onChange={e => setEmail(e.target.value)}
        aria-label="Email"
      />

      <label className="cp-label" style={{ marginTop: 8 }}>Telegram ID</label>
      <input
        className="cp-input"
        type="text"
        placeholder="ej: 7874537448"
        value={telegramId}
        onChange={e => setTelegramId(e.target.value)}
        aria-label="Telegram ID"
      />

      <label className="cp-label" style={{ marginTop: 8 }}>Notas</label>
      <textarea
        className="cp-textarea"
        rows={3}
        placeholder="Notas libres sobre este contacto..."
        value={notes}
        onChange={e => setNotes(e.target.value)}
        aria-label="Notas"
      />

      <label className="cp-checkbox-row">
        <input
          type="checkbox"
          checked={isFavorite}
          onChange={e => setIsFavorite(e.target.checked)}
        />
        <span>Marcar como favorito ⭐</span>
      </label>

      {error && <p className="cp-error">{error}</p>}

      <div className="cp-btn-row">
        <button className="cp-btn cp-btn-primary" onClick={handleSubmit} disabled={loading || !name.trim()}>
          {loading ? '...' : <><Check size={13} /> {isEdit ? 'Guardar' : 'Crear'}</>}
        </button>
        <button className="cp-btn cp-btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function ContactDetail({ contactId, onBack, onEdit, onDelete }) {
  const [contact, setContact] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch(`${API}/${contactId}`)
      .then(r => r.json())
      .then(data => { setContact(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [contactId]);

  if (loading) return <p className="cp-empty">Cargando...</p>;
  if (!contact) return <p className="cp-empty">No encontrado</p>;

  return (
    <div className="cp-detail">
      <div className="cp-detail-header">
        <button className="cp-back-btn" onClick={onBack} aria-label="Volver">←</button>
        <div className="cp-detail-name">
          {contact.name}
          {contact.is_favorite ? <Star size={14} className="cp-star-icon" /> : null}
        </div>
        <div className="cp-detail-actions">
          <button className="cp-icon-btn" onClick={() => onEdit(contact)} aria-label="Editar">
            <Pencil size={14} />
          </button>
          <button className="cp-icon-btn cp-icon-btn-danger" onClick={() => onDelete(contact)} aria-label="Eliminar">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="cp-detail-body">
        {contact.phone && (
          <div className="cp-detail-row">
            <Phone size={13} />
            <span>{contact.phone}</span>
          </div>
        )}
        {contact.email && (
          <div className="cp-detail-row">
            <Mail size={13} />
            <span>{contact.email}</span>
          </div>
        )}
        {contact.notes && (
          <div className="cp-detail-row cp-detail-notes">
            <FileText size={13} />
            <span>{contact.notes}</span>
          </div>
        )}
        {contact.linkedUser?.identities?.find(i => i.channel === 'telegram') && (
          <div className="cp-detail-row">
            <MessageSquare size={13} />
            <span>Telegram: {contact.linkedUser.identities.find(i => i.channel === 'telegram').identifier}</span>
          </div>
        )}
        {contact.linkedUser ? (
          <div className="cp-detail-row cp-linked">
            <Link size={13} />
            <span>
              Vinculado a <strong>{contact.linkedUser.name}</strong>
              {contact.linkedUser.identities?.length > 0 && (
                <span className="cp-linked-ids">
                  {' '}({contact.linkedUser.identities.map(i => `${i.channel}:${i.identifier}`).join(', ')})
                </span>
              )}
            </span>
          </div>
        ) : (
          <div className="cp-detail-row cp-not-linked">
            <Link size={13} />
            <span>Sin usuario vinculado</span>
          </div>
        )}
        <div className="cp-detail-id">ID: {contact.id}</div>
      </div>
    </div>
  );
}

function ContactRow({ contact, onSelect, onToggleFav, onDelete }) {
  const handleFav = async (e) => {
    e.stopPropagation();
    await onToggleFav(contact);
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    onDelete(contact);
  };

  return (
    <div className="cp-contact-row" onClick={() => onSelect(contact.id)} role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onSelect(contact.id)}>
      <div className="cp-contact-avatar">
        {contact.name.charAt(0).toUpperCase()}
      </div>
      <div className="cp-contact-info">
        <div className="cp-contact-name">
          {contact.name}
          {contact.user_id && <span className="cp-badge-linked" title="Vinculado">🔗</span>}
        </div>
        {(contact.phone || contact.email) && (
          <div className="cp-contact-sub">{contact.phone || contact.email}</div>
        )}
      </div>
      <div className="cp-contact-actions" onClick={e => e.stopPropagation()}>
        <button className={`cp-icon-btn ${contact.is_favorite ? 'cp-fav-active' : ''}`}
          onClick={handleFav} aria-label={contact.is_favorite ? 'Quitar favorito' : 'Marcar favorito'}>
          {contact.is_favorite ? <Star size={14} /> : <StarOff size={14} />}
        </button>
        <button className="cp-icon-btn cp-icon-btn-danger" onClick={handleDelete} aria-label="Eliminar">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export default function ContactsPanel({ onClose }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [view, setView] = useState('list'); // 'list' | 'new' | 'edit' | 'detail'
  const [selected, setSelected] = useState(null); // contacto editando o detalle
  const [favOnly, setFavOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (favOnly) params.set('favorites', 'true');
      const res = await apiFetch(`${API}?${params}`);
      const data = await res.json();
      setContacts(Array.isArray(data) ? data : []);
    } catch {
      setContacts([]);
    } finally {
      setLoading(false);
    }
  }, [query, favOnly]);

  useEffect(() => { load(); }, [load]);

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
    if (view === 'detail') setView('list');
    load();
  };

  const handleSaved = () => {
    setView('list');
    setSelected(null);
    load();
  };

  return (
    <div className="cp-panel" role="dialog" aria-label="Contactos">
      <div className="cp-header">
        <span className="cp-title">Contactos</span>
        <button className="cp-close-btn" onClick={onClose} aria-label="Cerrar">
          <X size={16} />
        </button>
      </div>

      {view === 'list' && (
        <>
          <div className="cp-toolbar">
            <input
              className="cp-search"
              type="search"
              placeholder="Buscar..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Buscar contactos"
            />
            <button
              className={`cp-btn cp-btn-sm ${favOnly ? 'cp-btn-active' : 'cp-btn-ghost'}`}
              onClick={() => setFavOnly(f => !f)}
              aria-pressed={favOnly}
              title="Solo favoritos"
            >
              <Star size={13} />
            </button>
            <button
              className="cp-btn cp-btn-primary cp-btn-sm"
              onClick={() => { setSelected(null); setView('new'); }}
              aria-label="Nuevo contacto"
            >
              <Plus size={13} />
            </button>
          </div>

          <div className="cp-list">
            {loading && <p className="cp-empty">Cargando...</p>}
            {!loading && contacts.length === 0 && (
              <p className="cp-empty">
                {query ? 'Sin resultados' : favOnly ? 'No hay favoritos' : 'No hay contactos'}
              </p>
            )}
            {!loading && contacts.map(c => (
              <ContactRow
                key={c.id}
                contact={c}
                onSelect={id => { setSelected(id); setView('detail'); }}
                onToggleFav={handleToggleFav}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </>
      )}

      {(view === 'new' || view === 'edit') && (
        <ContactForm
          initial={view === 'edit' ? selected : null}
          onSave={handleSaved}
          onCancel={() => { setView(selected?.id ? 'detail' : 'list'); }}
        />
      )}

      {view === 'detail' && selected && (
        <ContactDetail
          contactId={selected}
          onBack={() => { setSelected(null); setView('list'); }}
          onEdit={c => { setSelected(c); setView('edit'); }}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
