import { useState, useEffect, useCallback, useRef } from 'react';
import { Lock, CheckCircle, Sparkles, Square, Play, X, ChevronUp, ChevronDown, Eye, EyeOff, Check, Plus, Bot } from 'lucide-react';
import { API_BASE } from '../config.js';
import './TelegramPanel.css';

const API = `${API_BASE}/api/telegram`;

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

function ChatRow({ botKey, chat, onOpenSession, onRefresh }) {
  const [linking, setLinking] = useState(false);
  const [sessions, setSessions] = useState([]);

  const handleLink = async () => {
    if (linking) { setLinking(false); return; }
    try {
      const res = await fetch(`${API_BASE}/api/sessions`);
      const data = await res.json();
      setSessions(Array.isArray(data) ? data.filter(s => s.active) : []);
    } catch { setSessions([]); }
    setLinking(true);
  };

  const handleSelectSession = async (sessionId) => {
    setLinking(false);
    try {
      await fetch(`${API}/bots/${botKey}/chats/${chat.chatId}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      onRefresh();
    } catch { /* ignorar */ }
  };

  const handleDisconnect = async () => {
    try {
      await fetch(`${API}/bots/${botKey}/chats/${chat.chatId}`, { method: 'DELETE' });
      onRefresh();
    } catch { /* ignorar */ }
  };

  return (
    <div className="tg-chat-row">
      <div className="tg-chat-top">
        <span className="tg-chat-name">
          {chat.username ? `@${chat.username}` : chat.firstName || `Chat ${chat.chatId}`}
        </span>
        <span className="tg-chat-time">{timeAgo(chat.lastMessageAt)}</span>
      </div>
      {chat.lastPreview && (
        <p className="tg-chat-preview">"{chat.lastPreview}"</p>
      )}
      {chat.sessionId && (
        <p className="tg-chat-session">
          sesión: <code>{chat.sessionId.slice(0, 8)}…</code>
        </p>
      )}
      {linking && (
        <div className="tg-session-picker">
          {sessions.length === 0
            ? <span className="tg-session-empty">Sin sesiones activas</span>
            : sessions.map(s => (
              <button
                key={s.id}
                className="tg-session-option"
                onClick={() => handleSelectSession(s.id)}
              >
                <span className="tg-session-title">{s.title || s.id.slice(0, 8)}</span>
                <code className="tg-session-id">{s.id.slice(0, 8)}…</code>
              </button>
            ))
          }
        </div>
      )}
      <div className="tg-chat-btns">
        {chat.sessionId && (
          <button
            className="tg-btn tg-btn-sm tg-btn-ghost"
            onClick={() => onOpenSession(chat.sessionId)}
          >
            Ver terminal
          </button>
        )}
        <button
          className={`tg-btn tg-btn-sm ${linking ? 'tg-btn-link-active' : 'tg-btn-ghost'}`}
          onClick={handleLink}
        >
          {linking ? 'Cancelar' : 'Vincular'}
        </button>
        <button
          className="tg-btn tg-btn-sm tg-btn-danger-ghost"
          onClick={handleDisconnect}
        >
          Desconectar
        </button>
      </div>
    </div>
  );
}

function AccessConfig({ bot, onRefresh }) {
  const [ids, setIds] = useState((bot.whitelist || []).join(', '));
  const [groupIds, setGroupIds] = useState((bot.groupWhitelist || []).join(', '));
  const [limit, setLimit] = useState(bot.rateLimit ?? 30);
  const [keyword, setKeyword] = useState(bot.rateLimitKeyword || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    const whitelist = ids.split(',').map(s => Number(s.trim())).filter(Boolean);
    const groupWhitelist = groupIds.split(',').map(s => Number(s.trim())).filter(Boolean);
    await fetch(`${API}/bots/${bot.key}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ whitelist, groupWhitelist, rateLimit: Number(limit), rateLimitKeyword: keyword }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onRefresh();
  };

  return (
    <div className="access-config">
      <h4><Lock size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />Control de acceso</h4>
      <label>IDs de usuarios permitidos <span>(separados por coma — vacío = todos)</span></label>
      <input
        value={ids}
        onChange={e => setIds(e.target.value)}
        placeholder="123456789, 987654321"
      />
      <label>IDs de grupos permitidos <span>(separados por coma — vacío = todos)</span></label>
      <input
        value={groupIds}
        onChange={e => setGroupIds(e.target.value)}
        placeholder="-1001234567890, -1009876543210"
      />
      <label>Límite de mensajes por hora <span>(0 = sin límite)</span></label>
      <input
        type="number"
        min="0"
        value={limit}
        onChange={e => setLimit(e.target.value)}
      />
      <label>Palabra clave de emergencia <span>(enviar al bot para resetear el límite)</span></label>
      <input
        value={keyword}
        onChange={e => setKeyword(e.target.value)}
        placeholder="misecreta123"
      />
      <button onClick={save} disabled={saving}>
        {saved ? <><CheckCircle size={13} /> Guardado</> : saving ? 'Guardando…' : 'Guardar'}
      </button>
    </div>
  );
}

function BotCard({ bot, onOpenSession, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [allAgents, setAllAgents] = useState([]);

  useEffect(() => {
    fetch(`${API_BASE}/api/agents`)
      .then(r => r.json())
      .then(data => setAllAgents(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const handleStart = async () => {
    setLoading(true);
    try {
      await fetch(`${API}/bots/${bot.key}/start`, { method: 'POST' });
      onRefresh();
    } catch { /* ignorar */ } finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await fetch(`${API}/bots/${bot.key}/stop`, { method: 'POST' });
      onRefresh();
    } catch { /* ignorar */ } finally { setLoading(false); }
  };

  const handleRemove = async () => {
    if (!confirm(`¿Eliminar el bot "${bot.key}"?`)) return;
    setLoading(true);
    try {
      await fetch(`${API}/bots/${bot.key}`, { method: 'DELETE' });
      onRefresh();
    } catch { /* ignorar */ } finally { setLoading(false); }
  };

  const handleChangeAgent = async (e) => {
    e.stopPropagation();
    try {
      await fetch(`${API}/bots/${bot.key}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultAgent: e.target.value }),
      });
      onRefresh();
    } catch { /* ignorar */ }
  };

  return (
    <div className={`tg-bot-card ${bot.running ? 'running' : 'stopped'}`}>
      <div className="tg-bot-header" onClick={() => setExpanded(v => !v)}>
        <div className="tg-bot-info">
          <span className={`tg-status-dot ${bot.running ? 'active' : 'inactive'}`} />
          <span className="tg-bot-key">{bot.key}</span>
          {bot.botInfo && (
            <span className="tg-bot-username">@{bot.botInfo.username}</span>
          )}
          <select
            className="tg-agent-select"
            value={bot.defaultAgent || 'claude'}
            onChange={handleChangeAgent}
            onClick={e => e.stopPropagation()}
            title="Agente por defecto"
          >
            {allAgents.map(a => (
              <option key={a.key} value={a.key}>
                {a.key}{a.prompt ? ' *' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="tg-bot-actions" onClick={e => e.stopPropagation()}>
          {bot.running ? (
            <button className="tg-btn tg-btn-sm tg-btn-stop" onClick={handleStop} disabled={loading}>
              <Square size={11} /> Stop
            </button>
          ) : (
            <button className="tg-btn tg-btn-sm tg-btn-start" onClick={handleStart} disabled={loading}>
              <Play size={11} /> Start
            </button>
          )}
          <button className="tg-btn tg-btn-sm tg-btn-delete" onClick={handleRemove} disabled={loading} title="Eliminar bot">
            <X size={13} />
          </button>
          <span className="tg-bot-expand">{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        </div>
      </div>

      {expanded && (
        <div className="tg-bot-body">
          {bot.running && bot.chats.length === 0 && (
            <p className="tg-empty-small">Sin chats activos</p>
          )}
          {!bot.running && (
            <p className="tg-empty-small">Bot detenido</p>
          )}
          {bot.chats.map(chat => (
            <ChatRow
              key={chat.chatId}
              botKey={bot.key}
              chat={chat}
              onOpenSession={onOpenSession}
              onRefresh={onRefresh}
            />
          ))}
          <AccessConfig bot={bot} onRefresh={onRefresh} />
        </div>
      )}
    </div>
  );
}

function AddBotForm({ onAdd, onCancel }) {
  const [key, setKey] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setError('');
    if (!key.trim() || !token.trim()) { setError('Completá ambos campos'); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API}/bots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim(), token: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Error');
      onAdd();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="tg-add-form">
      <p className="tg-form-title">Agregar bot</p>

      <label className="tg-label">Clave (identificador)</label>
      <input
        className="tg-input"
        type="text"
        placeholder="mibot, iglesia, radio..."
        value={key}
        onChange={e => { setKey(e.target.value); setError(''); }}
      />

      <label className="tg-label" style={{ marginTop: 8 }}>Token de BotFather</label>
      <div className="tg-token-input-row">
        <input
          className="tg-input"
          type={showToken ? 'text' : 'password'}
          placeholder="123456:ABC-DEF..."
          value={token}
          onChange={e => { setToken(e.target.value); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
        />
        <button className="tg-icon-btn" onClick={() => setShowToken(v => !v)}>
          {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {error && <p className="tg-error">{error}</p>}

      <div className="tg-form-help">
        <p>Obtené el token en <strong>@BotFather</strong> → /newbot</p>
      </div>

      <div className="tg-btn-row">
        <button className="tg-btn tg-btn-primary" onClick={handleSubmit} disabled={loading || !key || !token}>
          {loading ? '...' : <><Check size={13} /> Agregar</>}
        </button>
        <button className="tg-btn tg-btn-ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

export default function TelegramPanel({ onClose, onOpenSession }) {
  const [bots, setBots] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const intervalRef = useRef(null);

  const fetchBots = useCallback(async () => {
    try {
      const res = await fetch(`${API}/bots`);
      const data = await res.json();
      setBots(Array.isArray(data) ? data : []);
    } catch { /* ignorar */ }
  }, []);

  useEffect(() => {
    fetchBots();
    intervalRef.current = setInterval(fetchBots, 3000);
    return () => clearInterval(intervalRef.current);
  }, [fetchBots]);

  const handleAdd = () => {
    setShowAdd(false);
    fetchBots();
  };

  const totalChats = bots.reduce((n, b) => n + (b.chats?.length || 0), 0);
  const activeBots = bots.filter(b => b.running).length;

  return (
    <div className="tg-panel">
      <div className="tg-header">
        <span className="tg-header-title">
          <span className="tg-icon"><Bot size={16} /></span>
          Bots de Telegram
          {activeBots > 0 && <span className="tg-header-badge">{activeBots} activo{activeBots > 1 ? 's' : ''}</span>}
        </span>
        <button className="tg-close" onClick={onClose} title="Cerrar"><X size={16} /></button>
      </div>

      <div className="tg-body">
        {/* Resumen */}
        {bots.length > 0 && (
          <div className="tg-summary">
            <span>{bots.length} bot{bots.length > 1 ? 's' : ''}</span>
            <span>·</span>
            <span>{totalChats} chat{totalChats !== 1 ? 's' : ''} activo{totalChats !== 1 ? 's' : ''}</span>
          </div>
        )}

        {/* Lista de bots */}
        {bots.length === 0 && !showAdd && (
          <div className="tg-empty-state">
            <p>Sin bots configurados</p>
            <p className="tg-empty-hint">Agregá tu primer bot con el token de @BotFather</p>
          </div>
        )}

        {bots.map(bot => (
          <BotCard
            key={bot.key}
            bot={bot}
            onOpenSession={(sessionId) => { onOpenSession(sessionId); onClose(); }}
            onRefresh={fetchBots}
          />
        ))}

        {/* Formulario agregar */}
        {showAdd ? (
          <AddBotForm onAdd={handleAdd} onCancel={() => setShowAdd(false)} />
        ) : (
          <button className="tg-btn tg-btn-add" onClick={() => setShowAdd(true)}>
            <Plus size={14} /> Agregar bot
          </button>
        )}
      </div>
    </div>
  );
}
