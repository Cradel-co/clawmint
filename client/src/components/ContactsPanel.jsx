import { useState, useEffect, useCallback } from 'react';
import { X, Plus, Star, StarOff, Pencil, Trash2, Check, Phone, Mail, FileText, Link, MessageSquare } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import styles from './ContactsPanel.module.css';

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

      // En edición, vincular por Telegram ID o username si se proporcionó
      if (isEdit && telegramId.trim()) {
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
    <div className={styles.form}>
      <p className={styles.formTitle}>{isEdit ? `Editar contacto` : 'Nuevo contacto'}</p>

      <label className={styles.label}>Nombre *</label>
      <input
        className={styles.input}
        type="text"
        placeholder="Juan García"
        value={name}
        onChange={e => { setName(e.target.value); setError(''); }}
        aria-label="Nombre del contacto"
      />

      <label className={styles.label} style={{ marginTop: 8 }}>Teléfono</label>
      <input
        className={styles.input}
        type="tel"
        placeholder="+54 11 1234-5678"
        value={phone}
        onChange={e => setPhone(e.target.value)}
        aria-label="Teléfono"
      />

      <label className={styles.label} style={{ marginTop: 8 }}>Email</label>
      <input
        className={styles.input}
        type="email"
        placeholder="juan@ejemplo.com"
        value={email}
        onChange={e => setEmail(e.target.value)}
        aria-label="Email"
      />

      <label className={styles.label} style={{ marginTop: 8 }}>Telegram (ID o @username)</label>
      <input
        className={styles.input}
        type="text"
        placeholder="ej: 7874537448 o @bpadilla3570"
        value={telegramId}
        onChange={e => setTelegramId(e.target.value)}
        aria-label="Telegram ID o username"
      />

      <label className={styles.label} style={{ marginTop: 8 }}>Notas</label>
      <textarea
        className={styles.textarea}
        rows={3}
        placeholder="Notas libres sobre este contacto..."
        value={notes}
        onChange={e => setNotes(e.target.value)}
        aria-label="Notas"
      />

      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={isFavorite}
          onChange={e => setIsFavorite(e.target.checked)}
        />
        <span>Marcar como favorito ⭐</span>
      </label>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.btnRow}>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSubmit} disabled={loading || !name.trim()}>
          {loading ? '...' : <><Check size={13} /> {isEdit ? 'Guardar' : 'Crear'}</>}
        </button>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onCancel}>
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

  if (loading) return <p className={styles.empty}>Cargando...</p>;
  if (!contact) return <p className={styles.empty}>No encontrado</p>;

  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <button className={styles.backBtn} onClick={onBack} aria-label="Volver">←</button>
        <div className={styles.detailName}>
          {contact.name}
          {contact.is_favorite ? <Star size={14} className={styles.starIcon} /> : null}
        </div>
        <div className={styles.detailActions}>
          <button className={styles.iconBtn} onClick={() => onEdit(contact)} aria-label="Editar">
            <Pencil size={14} />
          </button>
          <button className={`${styles.iconBtn} ${styles.iconBtnDanger}`} onClick={() => onDelete(contact)} aria-label="Eliminar">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className={styles.detailBody}>
        {contact.phone && (
          <div className={styles.detailRow}>
            <Phone size={13} />
            <span>{contact.phone}</span>
          </div>
        )}
        {contact.email && (
          <div className={styles.detailRow}>
            <Mail size={13} />
            <span>{contact.email}</span>
          </div>
        )}
        {contact.notes && (
          <div className={`${styles.detailRow} ${styles.detailNotes}`}>
            <FileText size={13} />
            <span>{contact.notes}</span>
          </div>
        )}
        {contact.linkedUser?.identities?.find(i => i.channel === 'telegram') && (
          <div className={styles.detailRow}>
            <MessageSquare size={13} />
            <span>Telegram: {contact.linkedUser.identities.find(i => i.channel === 'telegram').identifier}</span>
          </div>
        )}
        {contact.linkedUser ? (
          <div className={`${styles.detailRow} ${styles.linked}`}>
            <Link size={13} />
            <span>
              Vinculado a <strong>{contact.linkedUser.name}</strong>
              {contact.linkedUser.identities?.length > 0 && (
                <span className={styles.linkedIds}>
                  {' '}({contact.linkedUser.identities.map(i => `${i.channel}:${i.identifier}`).join(', ')})
                </span>
              )}
            </span>
          </div>
        ) : (
          <div className={`${styles.detailRow} ${styles.notLinked}`}>
            <Link size={13} />
            <span>Sin usuario vinculado</span>
          </div>
        )}
        <div className={styles.detailId}>ID: {contact.id}</div>
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
    <div className={styles.contactRow} onClick={() => onSelect(contact.id)} role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onSelect(contact.id)}>
      <div className={styles.contactAvatar}>
        {contact.name.charAt(0).toUpperCase()}
      </div>
      <div className={styles.contactInfo}>
        <div className={styles.contactName}>
          {contact.name}
          {contact.user_id && <span className={styles.badgeLinked} title="Vinculado">🔗</span>}
        </div>
        {(contact.phone || contact.email) && (
          <div className={styles.contactSub}>{contact.phone || contact.email}</div>
        )}
      </div>
      <div className={styles.contactActions} onClick={e => e.stopPropagation()}>
        <button className={`${styles.iconBtn} ${contact.is_favorite ? styles.favActive : ''}`}
          onClick={handleFav} aria-label={contact.is_favorite ? 'Quitar favorito' : 'Marcar favorito'}>
          {contact.is_favorite ? <Star size={14} /> : <StarOff size={14} />}
        </button>
        <button className={`${styles.iconBtn} ${styles.iconBtnDanger}`} onClick={handleDelete} aria-label="Eliminar">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export default function ContactsPanel({ onClose, embedded }) {
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
    <div className={styles.panel} role="dialog" aria-label="Contactos">
      <div className={styles.header}>
        <span className={styles.title}>Contactos</span>
        {!embedded && (
          <button className={styles.closeBtn} onClick={onClose} aria-label="Cerrar">
            <X size={16} />
          </button>
        )}
      </div>

      {view === 'list' && (
        <>
          <div className={styles.toolbar}>
            <input
              className={styles.search}
              type="search"
              placeholder="Buscar..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Buscar contactos"
            />
            <button
              className={`${styles.btn} ${styles.btnSm} ${favOnly ? styles.btnActive : styles.btnGhost}`}
              onClick={() => setFavOnly(f => !f)}
              aria-pressed={favOnly}
              title="Solo favoritos"
            >
              <Star size={13} />
            </button>
            <button
              className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSm}`}
              onClick={() => { setSelected(null); setView('new'); }}
              aria-label="Nuevo contacto"
            >
              <Plus size={13} />
            </button>
          </div>

          <div className={styles.list}>
            {loading && <p className={styles.empty}>Cargando...</p>}
            {!loading && contacts.length === 0 && (
              <p className={styles.empty}>
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
