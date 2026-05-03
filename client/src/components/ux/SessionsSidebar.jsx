import { useState, useEffect } from 'react';
import styles from './SessionsSidebar.module.css';

/**
 * SessionsSidebar (Fase D.3) — árbol colapsable de sesiones activas.
 *
 * Grupos:
 *   1. PTY sessions (desde sessionStore)
 *   2. AI chats (propio store)
 *   3. Telegram recientes (desde API)
 *
 * Drag-drop para reordenar con HTML5 native. Estado persistido en localStorage.
 *
 * Props:
 *   ptySessions      — array { id, name, cwd, status }
 *   aiChats          — array { id, agentKey, provider }
 *   telegramChats    — array { id, botKey, chatName, lastMessageAt }
 *   activeId         — id activo (cualquier tipo)
 *   onSelect(id,type) — callback
 *   onClose(id)       — callback para cerrar session PTY
 */
export default function SessionsSidebar({
  ptySessions = [],
  aiChats = [],
  telegramChats = [],
  activeId = null,
  onSelect,
  onClose,
}) {
  const [order, setOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sessionsSidebar.order') || '["pty","ai","telegram"]'); }
    catch { return ['pty', 'ai', 'telegram']; }
  });
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sessionsSidebar.collapsed') || '{}'); }
    catch { return {}; }
  });
  const [dragging, setDragging] = useState(null);

  useEffect(() => { try { localStorage.setItem('sessionsSidebar.order', JSON.stringify(order)); } catch {} }, [order]);
  useEffect(() => { try { localStorage.setItem('sessionsSidebar.collapsed', JSON.stringify(collapsed)); } catch {} }, [collapsed]);

  const groups = {
    pty: { title: 'PTY Sessions', items: ptySessions, type: 'pty' },
    ai: { title: 'AI Chats', items: aiChats, type: 'ai' },
    telegram: { title: 'Telegram', items: telegramChats, type: 'telegram' },
  };

  const toggleCollapse = (key) => setCollapsed(c => ({ ...c, [key]: !c[key] }));

  const onDragStart = (e, key) => {
    setDragging(key);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
  };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const onDrop = (e, targetKey) => {
    e.preventDefault();
    const src = e.dataTransfer.getData('text/plain') || dragging;
    if (!src || src === targetKey) { setDragging(null); return; }
    const next = order.filter(k => k !== src);
    const idx = next.indexOf(targetKey);
    next.splice(idx, 0, src);
    setOrder(next);
    setDragging(null);
  };
  const onDragEnd = () => setDragging(null);

  return (
    <aside className={styles.root} aria-label="Sesiones activas">
      {order.map(key => {
        const g = groups[key];
        if (!g) return null;
        const isCollapsed = !!collapsed[key];
        const count = g.items.length;
        return (
          <section
            key={key}
            className={`${styles.group} ${dragging === key ? styles.dragging : ''}`}
            draggable
            onDragStart={e => onDragStart(e, key)}
            onDragOver={onDragOver}
            onDrop={e => onDrop(e, key)}
            onDragEnd={onDragEnd}
          >
            <header className={styles.groupHeader} onClick={() => toggleCollapse(key)}>
              <span className={styles.caret}>{isCollapsed ? '▸' : '▾'}</span>
              <span className={styles.groupTitle}>{g.title}</span>
              <span className={styles.groupCount}>{count}</span>
              <span className={styles.dragHandle} title="Arrastrá para reordenar grupos">⋮⋮</span>
            </header>
            {!isCollapsed && (
              <ul className={styles.list}>
                {g.items.length === 0 ? (
                  <li className={styles.empty}>sin sesiones</li>
                ) : g.items.map(item => (
                  <Item key={item.id} item={item} type={g.type} active={item.id === activeId} onSelect={onSelect} onClose={onClose} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </aside>
  );
}

function Item({ item, type, active, onSelect, onClose }) {
  const label = item.name || item.chatName || item.agentKey || item.id;
  const subtitle = type === 'pty' ? (item.cwd || '')
    : type === 'ai' ? (item.provider || '')
    : type === 'telegram' ? (item.botKey || '')
    : '';
  return (
    <li
      className={`${styles.item} ${active ? styles.itemActive : ''}`}
      onClick={() => onSelect && onSelect(item.id, type)}
      role="button"
      tabIndex={0}
    >
      <span className={styles.itemIcon} aria-hidden="true">{iconForType(type, item)}</span>
      <span className={styles.itemBody}>
        <span className={styles.itemLabel}>{label}</span>
        {subtitle && <span className={styles.itemSub}>{subtitle}</span>}
      </span>
      {type === 'pty' && onClose && (
        <button
          className={styles.closeBtn}
          onClick={(e) => { e.stopPropagation(); onClose(item.id); }}
          aria-label="Cerrar sesión"
        >×</button>
      )}
    </li>
  );
}

function iconForType(type, item) {
  if (type === 'pty') return '⌨';
  if (type === 'ai') return '✦';
  if (type === 'telegram') return '✈';
  return '•';
}
