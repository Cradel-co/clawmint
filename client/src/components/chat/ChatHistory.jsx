import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, MessageSquare, Search, Pin, Pencil, Trash2, Archive, Home, MoreHorizontal, Plus, ChevronDown, Users, EyeOff } from 'lucide-react';
import { API_BASE } from '../../config.js';
import { getStoredTokens } from '../../authUtils.js';
import styles from '../WebChatPanel.module.css';

function authedFetch(path, opts = {}) {
  const { accessToken } = getStoredTokens();
  const headers = {
    ...(opts.headers || {}),
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
  };
  return fetch(`${API_BASE}${path}`, { ...opts, headers });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Ahora';
  if (mins < 60) return `Hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Hace ${days}d`;
  return d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

function buildTitle(s) {
  if (s.title) return s.title;
  const t = (s.preview || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'Conversación';
  return t.length > 50 ? t.slice(0, 50) + '…' : t;
}

function groupByPeriod(sessions) {
  const groups = { pinned: [], today: [], yesterday: [], lastWeek: [], older: [] };
  const now = Date.now();
  const dayMs = 86400000;
  for (const s of sessions) {
    if (s.pinned) { groups.pinned.push(s); continue; }
    const last = s.lastAt ? new Date(s.lastAt).getTime() : 0;
    const ageDays = (now - last) / dayMs;
    if (ageDays < 1)      groups.today.push(s);
    else if (ageDays < 2) groups.yesterday.push(s);
    else if (ageDays < 7) groups.lastWeek.push(s);
    else                  groups.older.push(s);
  }
  return groups;
}

function ConversationItem({ session, isActive, onSelect, onAction }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title || '');

  const handleAction = (action, ev) => {
    ev.stopPropagation();
    setMenuOpen(false);
    if (action === 'rename') {
      setRenameValue(session.title || buildTitle(session));
      setRenaming(true);
      return;
    }
    onAction(session.sessionId, action);
  };

  const submitRename = () => {
    const t = renameValue.trim();
    setRenaming(false);
    if (t && t !== session.title) onAction(session.sessionId, 'rename', { title: t });
  };

  if (renaming) {
    return (
      <div className={`${styles.historyItem} ${styles.historyItemRenaming}`}>
        <input
          autoFocus
          className={styles.historyRenameInput}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={submitRename}
        />
      </div>
    );
  }

  return (
    <div
      className={`${styles.historyItem} ${isActive ? styles.historyItemActive : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(session.sessionId)}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(session.sessionId); }}
      title={session.title || session.preview || ''}
    >
      <div className={styles.historyItemMain}>
        <span className={styles.historyPreview}>
          {session.pinned && <Pin size={11} className={styles.historyPinDot} />}
          {session.share_scope === 'household' && <Home size={11} className={styles.historyShareDot} />}
          {buildTitle(session)}
        </span>
        <span className={styles.historyMeta}>
          {formatDate(session.lastAt)}{session.agentKey ? ` · ${session.agentKey}` : ''} · {session.messageCount} msgs
        </span>
      </div>
      <button
        className={styles.historyItemMenuBtn}
        onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
        aria-label="Opciones"
      >
        <MoreHorizontal size={14} />
      </button>
      {menuOpen && (
        <>
          <div className={styles.historyMenuOverlay} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }} />
          <div className={styles.historyMenu}>
            <button onClick={(e) => handleAction('rename', e)}>
              <Pencil size={12} /> Renombrar
            </button>
            <button onClick={(e) => handleAction('pin', e)}>
              <Pin size={12} /> {session.pinned ? 'Desanclar' : 'Anclar'}
            </button>
            <button onClick={(e) => handleAction('share', e)}>
              <Home size={12} /> {session.share_scope === 'household' ? 'Quitar del hogar' : 'Compartir con hogar'}
            </button>
            <button onClick={(e) => handleAction('archive', e)}>
              <Archive size={12} /> Archivar
            </button>
            <button className={styles.historyMenuDanger} onClick={(e) => handleAction('delete', e)}>
              <Trash2 size={12} /> Eliminar
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SectionGroup({ label, items, currentSessionId, onSelect, onAction }) {
  if (!items || items.length === 0) return null;
  return (
    <div className={styles.historySection}>
      <h3 className={styles.historySectionLabel}>{label}</h3>
      {items.map(s => (
        <ConversationItem
          key={s.sessionId}
          session={s}
          isActive={s.sessionId === currentSessionId}
          onSelect={onSelect}
          onAction={onAction}
        />
      ))}
    </div>
  );
}

export default function ChatHistory({ open, onClose, onSelect, onNew, currentSessionId }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [newMenuOpen, setNewMenuOpen] = useState(false);

  const handleNew = (mode = 'normal') => {
    setNewMenuOpen(false);
    onNew?.({ mode });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authedFetch('/webchat/history');
      if (r.ok) {
        const data = await r.json();
        setSessions(data.sessions || []);
      } else {
        setSessions([]);
      }
    } catch { setSessions([]); }
    setLoading(false);
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => { if (!open) { setQuery(''); setSearchResults(null); } }, [open]);

  // Escuchar auto-titles del WebSocket → refrescar título en la lista sin re-fetch
  useEffect(() => {
    if (!open) return;
    const handler = (ev) => {
      const { sessionId, title } = ev.detail || {};
      if (!sessionId || !title) return;
      setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, title } : s));
    };
    window.addEventListener('webchat:session_title', handler);
    return () => window.removeEventListener('webchat:session_title', handler);
  }, [open]);

  // Búsqueda con debounce — local primero, server-side si query > 2 chars
  useEffect(() => {
    if (!query.trim()) { setSearchResults(null); return; }
    if (query.trim().length < 2) return;
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await authedFetch(`/webchat/search?q=${encodeURIComponent(query)}`);
        if (r.ok) {
          const data = await r.json();
          setSearchResults(data.results || []);
        }
      } catch {}
      setSearching(false);
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  const handleAction = useCallback(async (sessionId, action, payload) => {
    if (action === 'delete') {
      if (!confirm('¿Eliminar esta conversación? No se puede deshacer.')) return;
      const r = await authedFetch(`/webchat/sessions/${sessionId}`, { method: 'DELETE' });
      if (r.ok) {
        setSessions(prev => prev.filter(s => s.sessionId !== sessionId));
        if (sessionId === currentSessionId) onNew?.();
      }
      return;
    }
    if (action === 'archive') {
      const r = await authedFetch(`/webchat/sessions/${sessionId}`, {
        method: 'PATCH', body: JSON.stringify({ archived: true }),
      });
      if (r.ok) setSessions(prev => prev.filter(s => s.sessionId !== sessionId));
      return;
    }
    if (action === 'pin') {
      const target = sessions.find(s => s.sessionId === sessionId);
      const newVal = !(target?.pinned);
      const r = await authedFetch(`/webchat/sessions/${sessionId}`, {
        method: 'PATCH', body: JSON.stringify({ pinned: newVal }),
      });
      if (r.ok) setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, pinned: newVal } : s));
      return;
    }
    if (action === 'share') {
      const target = sessions.find(s => s.sessionId === sessionId);
      const newScope = target?.share_scope === 'household' ? 'user' : 'household';
      const r = await authedFetch(`/webchat/sessions/${sessionId}`, {
        method: 'PATCH', body: JSON.stringify({ share_scope: newScope }),
      });
      if (r.ok) setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, share_scope: newScope } : s));
      return;
    }
    if (action === 'rename') {
      const r = await authedFetch(`/webchat/sessions/${sessionId}`, {
        method: 'PATCH', body: JSON.stringify({ title: payload.title }),
      });
      if (r.ok) setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, title: payload.title } : s));
      return;
    }
  }, [sessions, currentSessionId, onNew]);

  const grouped = useMemo(() => groupByPeriod(sessions), [sessions]);
  const inSearchMode = query.trim().length >= 2 && searchResults !== null;

  return (
    <>
      {open && <div className={styles.historyOverlay} onClick={onClose} />}
      <div className={`${styles.historyPanel} ${open ? styles.historyPanelOpen : ''}`}>
        <div className={styles.historyHeader}>
          <span className={styles.historyTitle}>Conversaciones</span>
          <button className={styles.btnIcon} onClick={onClose} aria-label="Cerrar historial">
            <X size={14} />
          </button>
        </div>

        <div className={styles.historyNewWrap}>
          <button className={styles.historyNewBtn} onClick={() => handleNew('normal')}>
            <Plus size={14} /> Nuevo chat
          </button>
          <button
            className={styles.historyNewChevron}
            onClick={(e) => { e.stopPropagation(); setNewMenuOpen(o => !o); }}
            aria-label="Más opciones de nuevo chat"
          >
            <ChevronDown size={14} />
          </button>
          {newMenuOpen && (
            <>
              <div className={styles.historyMenuOverlay} onClick={() => setNewMenuOpen(false)} />
              <div className={styles.historyNewMenu}>
                <button onClick={() => handleNew('normal')}>
                  <MessageSquare size={13} />
                  <div className={styles.historyNewMenuText}>
                    <span>Nuevo chat</span>
                    <small>Privado, se guarda</small>
                  </div>
                </button>
                <button onClick={() => handleNew('household')}>
                  <Users size={13} />
                  <div className={styles.historyNewMenuText}>
                    <span>Chat grupal</span>
                    <small>Compartido con el hogar</small>
                  </div>
                </button>
                <button onClick={() => handleNew('incognito')}>
                  <EyeOff size={13} />
                  <div className={styles.historyNewMenuText}>
                    <span>Chat privado</span>
                    <small>No se guarda en memoria</small>
                  </div>
                </button>
              </div>
            </>
          )}
        </div>

        <div className={styles.historySearchWrap}>
          <Search size={13} className={styles.historySearchIcon} aria-hidden="true" />
          <input
            type="text"
            className={styles.historySearch}
            placeholder="Buscar chats..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Buscar conversaciones"
          />
        </div>

        <div className={styles.historyList}>
          {loading && <p className={styles.historyEmpty}>Cargando...</p>}

          {!loading && !inSearchMode && sessions.length === 0 && (
            <p className={styles.historyEmpty}>Sin conversaciones anteriores</p>
          )}

          {!loading && !inSearchMode && sessions.length > 0 && (
            <>
              <SectionGroup label="Anclados" items={grouped.pinned}
                currentSessionId={currentSessionId} onSelect={onSelect} onAction={handleAction} />
              <SectionGroup label="Hoy" items={grouped.today}
                currentSessionId={currentSessionId} onSelect={onSelect} onAction={handleAction} />
              <SectionGroup label="Ayer" items={grouped.yesterday}
                currentSessionId={currentSessionId} onSelect={onSelect} onAction={handleAction} />
              <SectionGroup label="Últimos 7 días" items={grouped.lastWeek}
                currentSessionId={currentSessionId} onSelect={onSelect} onAction={handleAction} />
              <SectionGroup label="Más viejos" items={grouped.older}
                currentSessionId={currentSessionId} onSelect={onSelect} onAction={handleAction} />
            </>
          )}

          {inSearchMode && (
            <div className={styles.historySection}>
              <h3 className={styles.historySectionLabel}>
                {searching ? 'Buscando...' : `Resultados (${searchResults.length})`}
              </h3>
              {!searching && searchResults.length === 0 && (
                <p className={styles.historyEmpty}>Ningún resultado para "{query}"</p>
              )}
              {searchResults.map(s => (
                <ConversationItem
                  key={s.sessionId}
                  session={{
                    ...s,
                    preview: s.snippet,
                    archived: false,
                  }}
                  isActive={s.sessionId === currentSessionId}
                  onSelect={onSelect}
                  onAction={handleAction}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

