import { useState, useEffect, useCallback, useRef, memo } from 'react';
import {
  Lock, CheckCircle, Square, Play, X, Eye, EyeOff, Check, Plus, Bot,
  Settings, Search, Send, Sparkles, ChevronRight,
} from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import useTelegramSocket from '../hooks/useTelegramSocket';
import './TelegramPanel.css';

const API = `${API_BASE}/api/telegram`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatChatTime(ts) {
  if (!ts) return '';
  const now  = new Date();
  const date = new Date(ts);
  const diff = now - date;
  const sameDay = now.toDateString() === date.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (yesterday.toDateString() === date.toDateString()) return 'ayer';
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString('es', { weekday: 'short' });
  }
  return date.toLocaleDateString('es', { day: '2-digit', month: '2-digit' });
}

const AVATAR_COLORS = ['#5b8df0','#f05b8d','#8df05b','#f0c45b','#8d5bf0','#5bf0c4','#f08d5b','#5bf08d'];
function avatarColor(name) {
  let h = 0;
  for (const c of (name || '?')) h = (h * 31 + c.charCodeAt(0)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}
function initials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
function chatDisplayName(chat) {
  if (chat.username) return `@${chat.username}`;
  return chat.firstName || `Chat ${chat.chatId}`;
}

// ── Avatar ───────────────────────────────────────────────────────────────────

function Avatar({ name, size = 36 }) {
  const color = avatarColor(name);
  return (
    <div className="tg-avatar" style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}>
      {initials(name)}
    </div>
  );
}

// ── ChatItem ─────────────────────────────────────────────────────────────────

const ChatItem = memo(function ChatItem({ chat, selected, onClick }) {
  const name = chatDisplayName(chat);
  return (
    <div className={`tg-chat-item ${selected ? 'selected' : ''}`} onClick={onClick}>
      <Avatar name={name} />
      <div className="tg-chat-item-body">
        <div className="tg-chat-item-top">
          <span className="tg-chat-item-name">{name}</span>
          <span className="tg-chat-item-time">{formatChatTime(chat.lastMessageAt)}</span>
        </div>
        <div className="tg-chat-item-bottom">
          <span className="tg-chat-item-preview">{chat.lastPreview || '—'}</span>
          {chat.unreadCount > 0 && (
            <span className="tg-unread-badge">{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</span>
          )}
        </div>
      </div>
    </div>
  );
});

// ── MessageBubble ─────────────────────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({ msg }) {
  const isBot = msg.role === 'bot';
  const time  = msg.ts ? new Date(msg.ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div className={`tg-bubble-row ${isBot ? 'bot' : 'user'}`}>
      <div className={`tg-bubble ${isBot ? 'tg-bubble-bot' : 'tg-bubble-user'}`}>
        <span className="tg-bubble-text">{msg.text}</span>
        {time && <span className="tg-bubble-time">{time}</span>}
      </div>
    </div>
  );
});

// ── SuggestBar ───────────────────────────────────────────────────────────────

function SuggestBar({ suggestion, suggesting, onSuggest, onUse, onDiscard }) {
  return (
    <div className="tg-suggest-bar">
      {suggestion ? (
        <div className="tg-suggest-preview">
          <span className="tg-suggest-label">✨ IA sugiere</span>
          <span className="tg-suggest-text">{suggestion}</span>
          <div className="tg-suggest-actions">
            <button className="tg-btn tg-btn-sm tg-btn-primary" onClick={onUse}>Usar</button>
            <button className="tg-btn tg-btn-sm tg-btn-ghost" onClick={onDiscard}>✕</button>
          </div>
        </div>
      ) : (
        <button className="tg-suggest-btn" onClick={onSuggest} disabled={suggesting}>
          <Sparkles size={13} />
          {suggesting ? 'Generando…' : 'IA sugiere'}
        </button>
      )}
    </div>
  );
}

// ── ChatView ──────────────────────────────────────────────────────────────────

function ChatView({ botKey, chat, messages, onSend }) {
  const [input, setInput]           = useState('');
  const [sending, setSending]       = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    setSuggestion('');
    try {
      await apiFetch(`${API}/bots/${botKey}/chats/${chat.chatId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch { /* el mensaje puede igualmente haber llegado */ }
    setSending(false);
    onSend?.();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    setSuggestion('');
    try {
      const res = await apiFetch(`${API}/bots/${botKey}/chats/${chat.chatId}/suggest`, { method: 'POST' });
      const data = await res.json();
      setSuggestion(data.suggestion || '');
    } catch { setSuggestion(''); }
    setSuggesting(false);
  };

  const name = chatDisplayName(chat);

  return (
    <div className="tg-chat-area">
      {/* Header */}
      <div className="tg-chat-header">
        <Avatar name={name} size={32} />
        <div className="tg-chat-header-info">
          <span className="tg-chat-header-name">{name}</span>
          {chat.username && <span className="tg-chat-header-sub">@{chat.username}</span>}
        </div>
      </div>

      {/* Mensajes */}
      <div className="tg-messages">
        {messages.length === 0 && (
          <div className="tg-messages-empty">Sin mensajes aún</div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={msg.id ?? i} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* IA sugiere + input */}
      <div className="tg-input-area">
        <SuggestBar
          suggestion={suggestion}
          suggesting={suggesting}
          onSuggest={handleSuggest}
          onUse={() => { setInput(suggestion); setSuggestion(''); }}
          onDiscard={() => setSuggestion('')}
        />
        <div className="tg-input-row">
          <textarea
            className="tg-input"
            placeholder="Escribí un mensaje…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={sending}
          />
          <button
            className="tg-send-btn"
            onClick={handleSend}
            disabled={!input.trim() || sending}
            aria-label="Enviar"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="tg-chat-area tg-chat-empty">
      <Bot size={40} style={{ opacity: 0.2 }} />
      <p>Seleccioná un chat para comenzar</p>
    </div>
  );
}

// ── BotManager (modal ⚙) ──────────────────────────────────────────────────────

function AccessConfig({ bot, onRefresh }) {
  const [ids, setIds]         = useState((bot.whitelist || []).join(', '));
  const [groupIds, setGroupIds] = useState((bot.groupWhitelist || []).join(', '));
  const [limit, setLimit]     = useState(bot.rateLimit ?? 30);
  const [keyword, setKeyword] = useState(bot.rateLimitKeyword || '');
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  const save = async () => {
    setSaving(true);
    const whitelist = ids.split(',').map(s => Number(s.trim())).filter(Boolean);
    const groupWhitelist = groupIds.split(',').map(s => Number(s.trim())).filter(Boolean);
    await apiFetch(`${API}/bots/${bot.key}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ whitelist, groupWhitelist, rateLimit: Number(limit), rateLimitKeyword: keyword }),
    });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onRefresh();
  };

  return (
    <div className="access-config">
      <h4><Lock size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />Control de acceso</h4>
      <label>IDs de usuarios permitidos <span>(vacío = todos)</span></label>
      <input value={ids} onChange={e => setIds(e.target.value)} placeholder="123456789, 987654321" />
      <label>IDs de grupos permitidos</label>
      <input value={groupIds} onChange={e => setGroupIds(e.target.value)} placeholder="-1001234567890" />
      <label>Límite mensajes/hora <span>(0 = sin límite)</span></label>
      <input type="number" min="0" value={limit} onChange={e => setLimit(e.target.value)} />
      <label>Palabra clave de emergencia</label>
      <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="misecreta123" />
      <button onClick={save} disabled={saving}>
        {saved ? <><CheckCircle size={13} /> Guardado</> : saving ? 'Guardando…' : 'Guardar'}
      </button>
    </div>
  );
}

const BotManagerCard = memo(function BotManagerCard({ bot, allAgents, onRefresh }) {
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleStart = async () => {
    setLoading(true);
    try { await apiFetch(`${API}/bots/${bot.key}/start`, { method: 'POST' }); onRefresh(); }
    catch {} finally { setLoading(false); }
  };
  const handleStop = async () => {
    setLoading(true);
    try { await apiFetch(`${API}/bots/${bot.key}/stop`, { method: 'POST' }); onRefresh(); }
    catch {} finally { setLoading(false); }
  };
  const handleRemove = async () => {
    if (!confirm(`¿Eliminar "${bot.key}"?`)) return;
    setLoading(true);
    try { await apiFetch(`${API}/bots/${bot.key}`, { method: 'DELETE' }); onRefresh(); }
    catch {} finally { setLoading(false); }
  };
  const handleChangeAgent = async (e) => {
    e.stopPropagation();
    try {
      await apiFetch(`${API}/bots/${bot.key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultAgent: e.target.value }),
      });
      onRefresh();
    } catch {}
  };

  return (
    <div className={`tg-bot-card ${bot.running ? 'running' : 'stopped'}`}>
      <div className="tg-bot-header" onClick={() => setExpanded(v => !v)}>
        <div className="tg-bot-info">
          <span className={`tg-status-dot ${bot.running ? 'active' : 'inactive'}`} />
          <span className="tg-bot-key">{bot.key}</span>
          {bot.botInfo && <span className="tg-bot-username">@{bot.botInfo.username}</span>}
          <select
            className="tg-agent-select"
            value={bot.defaultAgent || 'claude'}
            onChange={handleChangeAgent}
            onClick={e => e.stopPropagation()}
          >
            {allAgents.map(a => <option key={a.key} value={a.key}>{a.key}{a.prompt ? ' *' : ''}</option>)}
          </select>
        </div>
        <div className="tg-bot-actions" onClick={e => e.stopPropagation()}>
          {bot.running
            ? <button className="tg-btn tg-btn-sm tg-btn-stop" onClick={handleStop} disabled={loading}><Square size={11} /> Stop</button>
            : <button className="tg-btn tg-btn-sm tg-btn-start" onClick={handleStart} disabled={loading}><Play size={11} /> Start</button>
          }
          <button className="tg-btn tg-btn-sm tg-btn-delete" onClick={handleRemove} disabled={loading} aria-label="Eliminar"><X size={13} /></button>
          <span className="tg-bot-expand"><ChevronRight size={14} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} /></span>
        </div>
      </div>
      {expanded && (
        <div className="tg-bot-body">
          <p className="tg-empty-small">{bot.running ? `${bot.chats?.length || 0} chats activos` : 'Bot detenido'}</p>
          <AccessConfig bot={bot} onRefresh={onRefresh} />
        </div>
      )}
    </div>
  );
});

const AddBotForm = memo(function AddBotForm({ onAdd, onCancel }) {
  const [key, setKey]         = useState('');
  const [token, setToken]     = useState('');
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const handleSubmit = async () => {
    setError('');
    if (!key.trim() || !token.trim()) { setError('Completá ambos campos'); return; }
    setLoading(true);
    try {
      const res = await apiFetch(`${API}/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim(), token: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      onAdd();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="tg-add-form">
      <p className="tg-form-title">Agregar bot</p>
      <label className="tg-label">Clave (identificador)</label>
      <input className="tg-input-field" type="text" placeholder="mibot, iglesia…" value={key} onChange={e => { setKey(e.target.value); setError(''); }} />
      <label className="tg-label" style={{ marginTop: 8 }}>Token de BotFather</label>
      <div className="tg-token-input-row">
        <input className="tg-input-field" type={showToken ? 'text' : 'password'} placeholder="123456:ABC-DEF…" value={token} onChange={e => { setToken(e.target.value); setError(''); }} onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
        <button className="tg-icon-btn" onClick={() => setShowToken(v => !v)} aria-label={showToken ? 'Ocultar' : 'Mostrar'}>
          {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {error && <p className="tg-error">{error}</p>}
      <div className="tg-btn-row">
        <button className="tg-btn tg-btn-primary" onClick={handleSubmit} disabled={loading || !key || !token}>
          {loading ? '…' : <><Check size={13} /> Agregar</>}
        </button>
        <button className="tg-btn tg-btn-ghost" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
});

function BotManagerModal({ bots, allAgents, onClose, onRefresh }) {
  const [showAdd, setShowAdd] = useState(false);
  return (
    <div className="tg-modal-overlay" onClick={onClose}>
      <div className="tg-modal" onClick={e => e.stopPropagation()}>
        <div className="tg-modal-header">
          <span>Configuración de bots</span>
          <button className="tg-icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="tg-modal-body">
          {bots.map(bot => (
            <BotManagerCard key={bot.key} bot={bot} allAgents={allAgents} onRefresh={() => { onRefresh(); }} />
          ))}
          {showAdd
            ? <AddBotForm onAdd={() => { setShowAdd(false); onRefresh(); }} onCancel={() => setShowAdd(false)} />
            : <button className="tg-btn tg-btn-add" onClick={() => setShowAdd(true)}><Plus size={14} /> Agregar bot</button>
          }
        </div>
      </div>
    </div>
  );
}

// ── TelegramPanel ─────────────────────────────────────────────────────────────

export default function TelegramPanel({ onClose, onOpenSession, embedded, onBadgeChange }) {
  const [bots, setBots]               = useState([]);
  const [allAgents, setAllAgents]     = useState([]);
  const [activeBotKey, setActiveBotKey] = useState(null);
  const [selectedChatId, setSelectedChatId] = useState(null);
  const [chatMessages, setChatMessages] = useState({}); // `${botKey}:${chatId}` → []
  const [search, setSearch]           = useState('');
  const [showBotManager, setShowBotManager] = useState(false);
  // chatsState: Map de estado de chats recibido por WS (para unread/preview en tiempo real)
  const [wsChats, setWsChats]         = useState({}); // botKey → chats[]

  // ── WS ─────────────────────────────────────────────────────────────────────

  const handleWsMessage = useCallback((msg) => {
    if (msg.type === 'tg:chats_update') {
      setWsChats(prev => ({ ...prev, [msg.botKey]: msg.chats }));
      // Propagar badge de no leídos al padre
      if (onBadgeChange) {
        // Se recalcula al recibir cualquier update
        setTimeout(() => {
          setWsChats(current => {
            const total = Object.values(current).flat().reduce((a, c) => a + (c.unreadCount || 0), 0);
            onBadgeChange(total);
            return current;
          });
        }, 0);
      }
    }
    if (msg.type === 'tg:message') {
      const key = `${msg.botKey}:${msg.chatId}`;
      setChatMessages(prev => ({
        ...prev,
        [key]: [...(prev[key] || []), msg.message],
      }));
    }
  }, [onBadgeChange]);

  const { send: wsSend } = useTelegramSocket({ onMessage: handleWsMessage });

  // ── Fetch bots ──────────────────────────────────────────────────────────────

  const fetchBots = useCallback(async () => {
    try {
      const res  = await apiFetch(`${API}/bots`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setBots(list);
      if (!activeBotKey && list.length > 0) {
        setActiveBotKey(list.find(b => b.running)?.key || list[0].key);
      }
    } catch {}
  }, [activeBotKey]);

  useEffect(() => {
    fetchBots();
    apiFetch(`${API_BASE}/api/agents`)
      .then(r => r.json())
      .then(d => setAllAgents(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  // ── Seleccionar chat ────────────────────────────────────────────────────────

  const handleSelectChat = useCallback(async (botKey, chatId) => {
    setActiveBotKey(botKey);
    setSelectedChatId(chatId);
    const key = `${botKey}:${chatId}`;

    // Cargar historial si no lo tenemos aún
    if (!chatMessages[key]) {
      try {
        const res  = await apiFetch(`${API}/bots/${botKey}/chats/${chatId}/messages`);
        const data = await res.json();
        setChatMessages(prev => ({ ...prev, [key]: Array.isArray(data) ? data : [] }));
      } catch {
        setChatMessages(prev => ({ ...prev, [key]: [] }));
      }
    }

    // Notificar al servidor que el usuario abrió el chat (reset unread)
    wsSend({ type: 'tg:open', botKey, chatId });

    // Reset unread local
    setWsChats(prev => {
      const chats = prev[botKey] || [];
      return {
        ...prev,
        [botKey]: chats.map(c => c.chatId === chatId ? { ...c, unreadCount: 0 } : c),
      };
    });
  }, [chatMessages, wsSend]);

  // ── Datos del bot activo ────────────────────────────────────────────────────

  const activeBotData = bots.find(b => b.key === activeBotKey);

  // Mezclar chats del bot (desde REST) con actualizaciones WS (unread, preview en tiempo real)
  const mergedChats = (() => {
    if (!activeBotData) return [];
    const wsData = wsChats[activeBotKey] || [];
    return (activeBotData.chats || []).map(c => {
      const ws = wsData.find(w => w.chatId === c.chatId);
      return ws ? { ...c, ...ws } : c;
    });
  })();

  const filteredChats = search.trim()
    ? mergedChats.filter(c => chatDisplayName(c).toLowerCase().includes(search.toLowerCase()))
    : mergedChats;

  const selectedChat = mergedChats.find(c => c.chatId === selectedChatId);
  const msgKey = activeBotKey && selectedChatId ? `${activeBotKey}:${selectedChatId}` : null;
  const currentMessages = msgKey ? (chatMessages[msgKey] || []) : [];

  return (
    <div className="tg-panel" role="region" aria-label="Telegram Chat">
      {/* Sidebar izquierda */}
      <div className="tg-sidebar">
        {/* Bot tabs */}
        <div className="tg-bot-tabs">
          <div className="tg-bot-tabs-scroll">
            {bots.map(bot => {
              const botWsChats = wsChats[bot.key] || [];
              const botUnread  = botWsChats.reduce((a, c) => a + (c.unreadCount || 0), 0);
              return (
                <button
                  key={bot.key}
                  className={`tg-bot-tab ${activeBotKey === bot.key ? 'active' : ''} ${bot.running ? '' : 'offline'}`}
                  onClick={() => { setActiveBotKey(bot.key); setSelectedChatId(null); }}
                >
                  {bot.key}
                  {botUnread > 0 && <span className="tg-tab-badge">{botUnread > 99 ? '99+' : botUnread}</span>}
                </button>
              );
            })}
          </div>
          <button className="tg-icon-btn tg-settings-btn" onClick={() => setShowBotManager(true)} title="Configurar bots">
            <Settings size={15} />
          </button>
        </div>

        {/* Buscador */}
        <div className="tg-search-row">
          <Search size={13} className="tg-search-icon" />
          <input
            className="tg-search-input"
            placeholder="Buscar chat…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Lista de chats */}
        <div className="tg-chat-list">
          {!activeBotData && (
            <div className="tg-sidebar-empty">Sin bots configurados</div>
          )}
          {activeBotData && filteredChats.length === 0 && (
            <div className="tg-sidebar-empty">
              {search ? 'Sin resultados' : 'Sin chats activos'}
            </div>
          )}
          {filteredChats.map(chat => (
            <ChatItem
              key={chat.chatId}
              chat={chat}
              selected={selectedChatId === chat.chatId}
              onClick={() => handleSelectChat(activeBotKey, chat.chatId)}
            />
          ))}
        </div>
      </div>

      {/* Panel derecho */}
      {selectedChat
        ? <ChatView
            botKey={activeBotKey}
            chat={selectedChat}
            messages={currentMessages}
            onSend={fetchBots}
          />
        : <EmptyState />
      }

      {/* Modal de configuración de bots */}
      {showBotManager && (
        <BotManagerModal
          bots={bots}
          allAgents={allAgents}
          onClose={() => setShowBotManager(false)}
          onRefresh={fetchBots}
        />
      )}
    </div>
  );
}
