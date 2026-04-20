import { useEffect, useMemo, useState } from 'react';
import { Home, ShoppingCart, Calendar, StickyNote, Receipt, Refrigerator, Plus, Trash2, Check, RotateCcw, RefreshCw } from 'lucide-react';
import { household as api } from '../api/household';
import styles from './HouseholdPanel.module.css';

/**
 * Panel "Hogar" — datos compartidos entre miembros aprobados.
 * Tabs: Mercadería · Eventos · Notas · Servicios · Inventario.
 */

const TABS = [
  { id: 'grocery_item', label: 'Mercadería',  Icon: ShoppingCart, color: 'var(--accent-orange)' },
  { id: 'family_event', label: 'Eventos',     Icon: Calendar,     color: 'var(--accent-pink)' },
  { id: 'house_note',   label: 'Notas',       Icon: StickyNote,   color: 'var(--accent-amber)' },
  { id: 'service',      label: 'Servicios',   Icon: Receipt,      color: 'var(--accent-green)' },
  { id: 'inventory',    label: 'Inventario',  Icon: Refrigerator, color: 'var(--accent-cyan)' },
];

export default function HouseholdPanel() {
  const [tab, setTab] = useState('grocery_item');
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const includeCompleted = tab === 'family_event' || tab === 'house_note' || tab === 'service';
      const list = await api.list(tab, { includeCompleted, upcomingOnly: tab === 'family_event' || tab === 'service' });
      setItems(list);
    } catch (e) {
      setError(e.message);
      setItems([]);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [tab]);

  const tabMeta = TABS.find(t => t.id === tab);

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <h2 className={styles.title}>
          <Home size={20} aria-hidden="true" />
          Hogar
        </h2>
        <p className={styles.subtitle}>
          Datos compartidos entre todos los miembros aprobados de la familia.
        </p>
      </header>

      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
            style={tab === t.id ? { color: t.color, borderColor: t.color } : {}}
          >
            <t.Icon size={14} aria-hidden="true" /> {t.label}
          </button>
        ))}
        <button className={styles.refresh} onClick={load} disabled={loading} title="Refrescar">
          <RefreshCw size={14} className={loading ? styles.spin : ''} />
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.body}>
        {tab === 'grocery_item'  && <GroceryView items={items} reload={load} />}
        {tab === 'family_event'  && <EventView items={items} reload={load} />}
        {tab === 'house_note'    && <NoteView items={items} reload={load} />}
        {tab === 'service'       && <ServiceView items={items} reload={load} />}
        {tab === 'inventory'     && <InventoryView items={items} reload={load} />}
      </div>
    </div>
  );
}

// ── Mercadería ──────────────────────────────────────────────────────────────

function GroceryView({ items, reload }) {
  const [text, setText] = useState('');
  const [qty, setQty]   = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.create('grocery_item', { title: text.trim(), data: { quantity: qty.trim() || null } });
      setText(''); setQty('');
      reload();
    } finally { setBusy(false); }
  };

  const toggle = async (item) => {
    await (item.completed_at ? api.uncomplete('grocery_item', item.id) : api.complete('grocery_item', item.id));
    reload();
  };

  const remove = async (id) => { await api.remove('grocery_item', id); reload(); };

  if (!items) return <div className={styles.empty}>Cargando…</div>;
  return (
    <>
      <form onSubmit={add} className={styles.addForm}>
        <input
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="ej: leche, pan, manzanas…"
          className={styles.input}
          autoFocus
        />
        <input
          type="text"
          value={qty}
          onChange={e => setQty(e.target.value)}
          placeholder="cant."
          className={styles.inputSmall}
        />
        <button type="submit" disabled={busy || !text.trim()} className={styles.btnPrimary}>
          <Plus size={14} /> Agregar
        </button>
      </form>

      {items.length === 0 ? (
        <div className={styles.empty}>Lista vacía. Agregá algo arriba o decile al agente "agregá manteca".</div>
      ) : (
        <ul className={styles.list}>
          {items.map(i => (
            <li key={i.id} className={`${styles.listItem} ${i.completed_at ? styles.completed : ''}`}>
              <button className={styles.checkBtn} onClick={() => toggle(i)} title={i.completed_at ? 'Desmarcar' : 'Comprado'}>
                <Check size={14} />
              </button>
              <span className={styles.itemTitle}>{i.title}</span>
              {i.data?.quantity && <span className={styles.tagSmall}>{i.data.quantity}</span>}
              <button className={styles.btnDanger} onClick={() => remove(i.id)} title="Borrar"><Trash2 size={12} /></button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Eventos familiares ─────────────────────────────────────────────────────

function EventView({ items, reload }) {
  const [title, setTitle] = useState('');
  const [date, setDate]   = useState('');
  const [type, setType]   = useState('birthday');
  const [alertDays, setAlertDays] = useState(3);

  const add = async (e) => {
    e.preventDefault();
    if (!title || !date) return;
    await api.create('family_event', {
      title, dateAt: new Date(date + 'T09:00:00').getTime(),
      alertDaysBefore: Number(alertDays),
      data: { type, recurrence: type === 'birthday' ? 'yearly' : 'none' },
    });
    setTitle(''); setDate('');
    reload();
  };

  if (!items) return <div className={styles.empty}>Cargando…</div>;
  return (
    <>
      <form onSubmit={add} className={styles.addForm}>
        <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="ej: Cumple de Tomás" className={styles.input} />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className={styles.inputSmall} />
        <select value={type} onChange={e => setType(e.target.value)} className={styles.inputSmall}>
          <option value="birthday">Cumple</option>
          <option value="appointment">Cita</option>
          <option value="meeting">Reunión</option>
          <option value="other">Otro</option>
        </select>
        <input type="number" min="0" max="30" value={alertDays} onChange={e => setAlertDays(e.target.value)} className={styles.inputTiny} title="Días antes de avisar" />
        <button type="submit" disabled={!title || !date} className={styles.btnPrimary}><Plus size={14} /> Agregar</button>
      </form>

      {items.length === 0 ? (
        <div className={styles.empty}>Sin eventos próximos. Agregá cumpleaños, citas o vencimientos.</div>
      ) : (
        <ul className={styles.list}>
          {items.map(i => (
            <li key={i.id} className={styles.listItem}>
              <span className={styles.eventDate}>{formatDate(i.date_at)}</span>
              <span className={styles.itemTitle}>{i.title}</span>
              {i.data?.type && <span className={styles.tagSmall}>{i.data.type}</span>}
              {i.alert_days_before > 0 && <span className={styles.tagDim}>aviso {i.alert_days_before}d antes</span>}
              <button className={styles.btnDanger} onClick={() => api.remove('family_event', i.id).then(reload)}><Trash2 size={12} /></button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Notas ──────────────────────────────────────────────────────────────────

function NoteView({ items, reload }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const add = async (e) => {
    e.preventDefault();
    if (!title || !content) return;
    await api.create('house_note', { title, data: { content } });
    setTitle(''); setContent('');
    reload();
  };

  if (!items) return <div className={styles.empty}>Cargando…</div>;
  return (
    <>
      <form onSubmit={add} className={styles.addForm} style={{ flexWrap: 'wrap' }}>
        <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Título (ej: Wifi)" className={styles.input} />
        <input type="text" value={content} onChange={e => setContent(e.target.value)} placeholder="Contenido…" className={styles.input} style={{ flex: 2 }} />
        <button type="submit" disabled={!title || !content} className={styles.btnPrimary}><Plus size={14} /> Guardar</button>
      </form>

      {items.length === 0 ? (
        <div className={styles.empty}>Sin notas. Guardá info estable: wifi, plomero, dirección colegio…</div>
      ) : (
        <ul className={styles.list}>
          {items.map(i => (
            <li key={i.id} className={styles.noteItem}>
              <div className={styles.noteHead}>
                <strong>{i.title}</strong>
                <button className={styles.btnDanger} onClick={() => api.remove('house_note', i.id).then(reload)}><Trash2 size={12} /></button>
              </div>
              <div className={styles.noteContent}>{i.data?.content}</div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Servicios ──────────────────────────────────────────────────────────────

function ServiceView({ items, reload }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');

  const add = async (e) => {
    e.preventDefault();
    if (!name || !date) return;
    await api.create('service', {
      title: name, dateAt: new Date(date + 'T12:00:00').getTime(),
      alertDaysBefore: 5,
      data: { amount: amount ? Number(amount) : null, currency: 'ARS' },
    });
    setName(''); setDate(''); setAmount('');
    reload();
  };

  if (!items) return <div className={styles.empty}>Cargando…</div>;
  return (
    <>
      <form onSubmit={add} className={styles.addForm}>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="ej: Edenor luz" className={styles.input} />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className={styles.inputSmall} />
        <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="$ ARS" className={styles.inputSmall} />
        <button type="submit" disabled={!name || !date} className={styles.btnPrimary}><Plus size={14} /> Agregar</button>
      </form>

      {items.length === 0 ? (
        <div className={styles.empty}>Sin servicios cargados. Agregá vencimientos de gas, luz, internet…</div>
      ) : (
        <ul className={styles.list}>
          {items.map(i => {
            const days = Math.ceil((i.date_at - Date.now()) / 86400000);
            return (
              <li key={i.id} className={`${styles.listItem} ${i.completed_at ? styles.completed : ''}`}>
                <span className={styles.eventDate}>{formatDate(i.date_at)}</span>
                <span className={styles.itemTitle}>{i.title}</span>
                {i.data?.amount && <span className={styles.tagSmall}>${i.data.amount} {i.data.currency || ''}</span>}
                {!i.completed_at && days <= 5 && days >= 0 && <span className={styles.tagDanger}>vence en {days}d</span>}
                {!i.completed_at && days < 0 && <span className={styles.tagDanger}>VENCIDO</span>}
                <button className={styles.btnSecondary} onClick={() => api.complete('service', i.id).then(reload)} title="Marcar pagado">
                  <Check size={12} /> Pagado
                </button>
                <button className={styles.btnDanger} onClick={() => api.remove('service', i.id).then(reload)}><Trash2 size={12} /></button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ── Inventario ─────────────────────────────────────────────────────────────

function InventoryView({ items, reload }) {
  const [name, setName] = useState('');
  const [qty, setQty]   = useState('');
  const [location, setLocation] = useState('despensa');

  const add = async (e) => {
    e.preventDefault();
    if (!name) return;
    await api.create('inventory', { title: name, data: { quantity: qty || '1', location } });
    setName(''); setQty('');
    reload();
  };

  if (!items) return <div className={styles.empty}>Cargando…</div>;
  return (
    <>
      <form onSubmit={add} className={styles.addForm}>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="ej: leche larga vida" className={styles.input} />
        <input type="text" value={qty} onChange={e => setQty(e.target.value)} placeholder="cant." className={styles.inputSmall} />
        <select value={location} onChange={e => setLocation(e.target.value)} className={styles.inputSmall}>
          <option value="despensa">Despensa</option>
          <option value="heladera">Heladera</option>
          <option value="freezer">Freezer</option>
          <option value="otros">Otros</option>
        </select>
        <button type="submit" disabled={!name} className={styles.btnPrimary}><Plus size={14} /> Agregar</button>
      </form>

      {items.length === 0 ? (
        <div className={styles.empty}>Sin inventario cargado. Anotá qué hay en heladera/despensa.</div>
      ) : (
        <ul className={styles.list}>
          {items.map(i => (
            <li key={i.id} className={styles.listItem}>
              <span className={styles.itemTitle}>{i.title}</span>
              {i.data?.quantity && <span className={styles.tagSmall}>{i.data.quantity}</span>}
              {i.data?.location && <span className={styles.tagDim}>{i.data.location}</span>}
              <button className={styles.btnSecondary} onClick={() => api.complete('inventory', i.id).then(reload)} title="Consumido">
                <Check size={12} /> Consumido
              </button>
              <button className={styles.btnDanger} onClick={() => api.remove('inventory', i.id).then(reload)}><Trash2 size={12} /></button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function formatDate(ms) {
  if (!ms) return '—';
  try {
    const d = new Date(ms);
    return d.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' });
  } catch { return '—'; }
}
