import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { Lock, CheckCircle, Sparkles, Square, Play, X, ChevronUp, ChevronDown, Eye, EyeOff, Check, Plus, Bot } from 'lucide-react';
import { API_BASE } from '../config';
import { apiFetch } from '../authUtils';
import { useTelegramBots, useInvalidateTelegramBots } from '../api/telegram';
import { useAgents } from '../api/agents';
import styles from './TelegramPanel.module.css';

const API = `${API_BASE}/api/telegram`;

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

const ChatRow = memo(function ChatRow({ botKey, chat, onOpenSession, onRefresh }) {
  const [linking, setLinking] = useState(false);
  const [sessions, setSessions] = useState([]);

  const handleLink = async () => {
    if (linking) { setLinking(false); return; }
    try {
      const res = await apiFetch(`${API_BASE}/api/sessions`);
      const data = await res.json();
      setSessions(Array.isArray(data) ? data.filter(s => s.active) : []);
    } catch { setSessions([]); }
    setLinking(true);
  };

  const handleSelectSession = async (sessionId) => {
    setLinking(false);
    try {
      await apiFetch(`${API}/bots/${botKey}/chats/${chat.chatId}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      onRefresh();
    } catch { /* ignorar */ }
  };

  const handleDisconnect = async () => {
    try {
      await apiFetch(`${API}/bots/${botKey}/chats/${chat.chatId}`, { method: 'DELETE' });
      onRefresh();
    } catch { /* ignorar */ }
  };

  return (
    <div className={styles.chatRow}>
      <div className={styles.chatTop}>
        <span className={styles.chatName}>
          {chat.username ? `@${chat.username}` : chat.firstName || `Chat ${chat.chatId}`}
        </span>
        <span className={styles.chatTime}>{timeAgo(chat.lastMessageAt)}</span>
      </div>
      {chat.lastPreview && (
        <p className={styles.chatPreview}>"{chat.lastPreview}"</p>
      )}
      {chat.sessionId && (
        <p className={styles.chatSession}>
          sesión: <code>{chat.sessionId.slice(0, 8)}…</code>
        </p>
      )}
      {linking && (
        <div className={styles.sessionPicker}>
          {sessions.length === 0
            ? <span className={styles.sessionEmpty}>Sin sesiones activas</span>
            : sessions.map(s => (
              <button
                key={s.id}
                className={styles.sessionOption}
                onClick={() => handleSelectSession(s.id)}
              >
                <span className={styles.sessionTitle}>{s.title || s.id.slice(0, 8)}</span>
                <code className={styles.sessionId}>{s.id.slice(0, 8)}…</code>
              </button>
            ))
          }
        </div>
      )}
      <div className={styles.chatBtns}>
        {chat.sessionId && (
          <button
            className={`${styles.btn} ${styles.btnSm} ${styles.btnGhost}`}
            onClick={() => onOpenSession(chat.sessionId)}
          >
            Ver terminal
          </button>
        )}
        <button
          className={`${styles.btn} ${styles.btnSm} ${linking ? styles.btnLinkActive : styles.btnGhost}`}
          onClick={handleLink}
        >
          {linking ? 'Cancelar' : 'Vincular'}
        </button>
        <button
          className={`${styles.btn} ${styles.btnSm} ${styles.btnDangerGhost}`}
          onClick={handleDisconnect}
        >
          Desconectar
        </button>
      </div>
    </div>
  );
});

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
    await apiFetch(`${API}/bots/${bot.key}`, {
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
    <div className={styles.accessConfig}>
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

const BotCard = memo(function BotCard({ bot, allAgents, onOpenSession, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleStart = async () => {
    setLoading(true);
    try {
      await apiFetch(`${API}/bots/${bot.key}/start`, { method: 'POST' });
      onRefresh();
    } catch { /* ignorar */ } finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await apiFetch(`${API}/bots/${bot.key}/stop`, { method: 'POST' });
      onRefresh();
    } catch { /* ignorar */ } finally { setLoading(false); }
  };

  const handleRemove = async () => {
    if (!confirm(`¿Eliminar el bot "${bot.key}"?`)) return;
    setLoading(true);
    try {
      await apiFetch(`${API}/bots/${bot.key}`, { method: 'DELETE' });
      onRefresh();
    } catch { /* ignorar */ } finally { setLoading(false); }
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
    } catch { /* ignorar */ }
  };

  return (
    <div className={`${styles.botCard} ${bot.running ? styles.running : ''}`}>
      <div className={styles.botHeader} onClick={() => setExpanded(v => !v)}>
        <div className={styles.botInfo}>
          <span className={`${styles.statusDot} ${bot.running ? styles.active : styles.inactive}`} />
          <span className={styles.botKey}>{bot.key}</span>
          {bot.botInfo && (
            <span className={styles.botUsername}>@{bot.botInfo.username}</span>
          )}
          <select
            className={styles.agentSelect}
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
        <div className={styles.botActions} onClick={e => e.stopPropagation()}>
          {bot.running ? (
            <button className={`${styles.btn} ${styles.btnSm} ${styles.btnStop}`} onClick={handleStop} disabled={loading}>
              <Square size={11} /> Stop
            </button>
          ) : (
            <button className={`${styles.btn} ${styles.btnSm} ${styles.btnStart}`} onClick={handleStart} disabled={loading}>
              <Play size={11} /> Start
            </button>
          )}
          <button className={`${styles.btn} ${styles.btnSm} ${styles.btnDelete}`} onClick={handleRemove} disabled={loading} title="Eliminar bot" aria-label="Eliminar bot">
            <X size={13} />
          </button>
          <span className={styles.botExpand}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        </div>
      </div>

      {expanded && (
        <div className={styles.botBody}>
          {bot.running && bot.chats.length === 0 && (
            <p className={styles.emptySmall}>Sin chats activos</p>
          )}
          {!bot.running && (
            <p className={styles.emptySmall}>Bot detenido</p>
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
});

const AddBotForm = memo(function AddBotForm({ onAdd, onCancel }) {
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
      const res = await apiFetch(`${API}/bots`, {
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
    <div className={styles.addForm}>
      <p className={styles.formTitle}>Agregar bot</p>

      <label className={styles.label}>Clave (identificador)</label>
      <input
        className={styles.input}
        type="text"
        placeholder="mibot, iglesia, radio..."
        value={key}
        onChange={e => { setKey(e.target.value); setError(''); }}
      />

      <label className={styles.label} style={{ marginTop: 8 }}>Token de BotFather</label>
      <div className={styles.tokenInputRow}>
        <input
          className={styles.input}
          type={showToken ? 'text' : 'password'}
          placeholder="123456:ABC-DEF..."
          value={token}
          onChange={e => { setToken(e.target.value); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
        />
        <button className={styles.iconBtn} onClick={() => setShowToken(v => !v)} aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}>
          {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.formHelp}>
        <p>Obtené el token en <strong>@BotFather</strong> → /newbot</p>
      </div>

      <div className={styles.btnRow}>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleSubmit} disabled={loading || !key || !token}>
          {loading ? '...' : <><Check size={13} /> Agregar</>}
        </button>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
});

export default function TelegramPanel({ onClose, onOpenSession, embedded }) {
  const { data: bots = [] } = useTelegramBots();
  const { data: allAgents = [] } = useAgents();
  const invalidateBots = useInvalidateTelegramBots();
  const [showAdd, setShowAdd] = useState(false);

  const fetchBots = invalidateBots; // alias para compatibilidad con componentes hijos

  const handleAdd = () => {
    setShowAdd(false);
    fetchBots();
  };

  const totalChats = bots.reduce((n, b) => n + (b.chats?.length || 0), 0);
  const activeBots = bots.filter(b => b.running).length;

  return (
    <div className={styles.panel} role="region" aria-label="Panel de Telegram">
      {!embedded && (
        <div className={styles.header}>
          <span className={styles.headerTitle}>
            <span className={styles.icon}><Bot size={16} /></span>
            Bots de Telegram
            {activeBots > 0 && <span className={styles.headerBadge}>{activeBots} activo{activeBots > 1 ? 's' : ''}</span>}
          </span>
          <button className={styles.close} onClick={onClose} aria-label="Cerrar panel de Telegram"><X size={16} /></button>
        </div>
      )}

      <div className={styles.body}>
        {/* Resumen */}
        {bots.length > 0 && (
          <div className={styles.summary}>
            <span>{bots.length} bot{bots.length > 1 ? 's' : ''}</span>
            <span>·</span>
            <span>{totalChats} chat{totalChats !== 1 ? 's' : ''} activo{totalChats !== 1 ? 's' : ''}</span>
          </div>
        )}

        {/* Lista de bots */}
        {bots.length === 0 && !showAdd && (
          <div className={styles.emptyState}>
            <p>Sin bots configurados</p>
            <p className={styles.emptyHint}>Agregá tu primer bot con el token de @BotFather</p>
          </div>
        )}

        {bots.map(bot => (
          <BotCard
            key={bot.key}
            bot={bot}
            allAgents={allAgents}
            onOpenSession={(sessionId) => { onOpenSession(sessionId); onClose(); }}
            onRefresh={fetchBots}
          />
        ))}

        {/* Formulario agregar */}
        {showAdd ? (
          <AddBotForm onAdd={handleAdd} onCancel={() => setShowAdd(false)} />
        ) : (
          <button className={`${styles.btn} ${styles.btnAdd}`} onClick={() => setShowAdd(true)}>
            <Plus size={14} /> Agregar bot
          </button>
        )}
      </div>
    </div>
  );
}
