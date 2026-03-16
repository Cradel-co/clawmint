import { useState, useCallback, useRef, useEffect } from 'react';
import TabBar from './components/TabBar.jsx';
import CommandBar from './components/CommandBar.jsx';
import TerminalPanel from './components/TerminalPanel.jsx';
import TelegramPanel from './components/TelegramPanel.jsx';
import AgentsPanel from './components/AgentsPanel.jsx';
import ProvidersPanel from './components/ProvidersPanel.jsx';
import './App.css';

const WS_URL = 'ws://localhost:3001';
let nextId = 1;

function createSession(command = null, type = 'pty', httpSessionId = null, provider = null) {
  const id = nextId++;
  let title;
  if (provider === 'gemini') {
    title = `Gemini ${id}`;
  } else if (provider === 'openai') {
    title = `GPT ${id}`;
  } else if (provider === 'anthropic' || type === 'claude') {
    title = `Claude ${id}`;
  } else if (command && command.startsWith('claude')) {
    title = `CC ${id}`;
  } else {
    title = command ? command.split(' ')[0] : `bash ${id}`;
  }
  return { id, title, command, type, httpSessionId, provider };
}

export default function App() {
  const [sessions, setSessions] = useState(() => [createSession()]);
  const [activeId, setActiveId] = useState(1);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [telegramChatsCount, setTelegramChatsCount] = useState(0);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);

  // Mapa: httpSessionId → frontendTabId
  const httpIdToTabId = useRef(new Map());

  // WebSocket listener para eventos de Telegram (abre pestañas automáticamente)
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'init', sessionType: 'listener' }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'telegram_session') {
          const { sessionId, from } = msg;
          // Si ya hay una pestaña para esta sesión, solo activarla
          if (httpIdToTabId.current.has(sessionId)) {
            setActiveId(httpIdToTabId.current.get(sessionId));
            return;
          }
          // Abrir pestaña nueva adjunta a la sesión Telegram
          setSessions((prev) => {
            const s = createSession(null, 'pty', sessionId);
            s.title = `TG: ${from}`;
            setActiveId(s.id);
            return [...prev, s];
          });
        }
      } catch { /* ignorar */ }
    };
    return () => ws.close();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Obtener cantidad de chats activos del bot para el badge
  useEffect(() => {
    if (!telegramOpen) {
      const interval = setInterval(async () => {
        try {
          const res = await fetch('http://localhost:3001/api/telegram/bots');
          const bots = await res.json();
          const chats = Array.isArray(bots)
            ? bots.reduce((n, b) => n + (b.chats?.length || 0), 0)
            : 0;
          setTelegramChatsCount(chats);
        } catch { /* ignorar */ }
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [telegramOpen]);

  const openNew = useCallback((command = null, type = 'pty', httpSessionId = null, provider = null) => {
    const session = createSession(command, type, httpSessionId, provider);
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
    return session;
  }, []);

  const closeSession = useCallback((id) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (next.length === 0) {
        const s = createSession();
        setActiveId(s.id);
        return [s];
      }
      if (activeId === id) {
        setActiveId(next[next.length - 1].id);
      }
      return next;
    });
  }, [activeId]);

  // Registrar httpSessionId → frontendTabId
  const handleSessionId = useCallback((frontendTabId, httpId) => {
    httpIdToTabId.current.set(httpId, frontendTabId);
  }, []);

  // Abrir o activar tab por httpSessionId (llamado desde TelegramPanel)
  const handleOpenSession = useCallback((httpSessionId) => {
    const tabId = httpIdToTabId.current.get(httpSessionId);
    if (tabId) {
      setActiveId(tabId);
      setTelegramOpen(false);
    } else {
      // La sesión no tiene tab abierto → abrir uno nuevo adjunto a esa sesión HTTP
      openNew(null, 'pty', httpSessionId);
      setTelegramOpen(false);
    }
  }, [openNew]);

  return (
    <div className="app">
      <header className="app-header">
        <span className="dot red" />
        <span className="dot yellow" />
        <span className="dot green" />
        <span className="title">Terminal Live</span>

        <div className="header-right">
          <button
            className={`telegram-btn ${providersOpen ? 'active' : ''}`}
            onClick={() => { setProvidersOpen(v => !v); setAgentsOpen(false); setTelegramOpen(false); }}
            title="Providers de IA"
          >
            ⚙️
          </button>
          <button
            className={`telegram-btn ${agentsOpen ? 'active' : ''}`}
            onClick={() => { setAgentsOpen(v => !v); setTelegramOpen(false); setProvidersOpen(false); }}
            title="Agentes personalizados"
          >
            🎭
          </button>
          <button
            className={`telegram-btn ${telegramOpen ? 'active' : ''}`}
            onClick={() => { setTelegramOpen(v => !v); setAgentsOpen(false); setProvidersOpen(false); }}
            title="Panel de Telegram"
          >
            🤖
            {telegramChatsCount > 0 && !telegramOpen && (
              <span className="telegram-badge">{telegramChatsCount}</span>
            )}
          </button>
        </div>
      </header>

      <TabBar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={closeSession}
        onNew={() => openNew()}
      />

      <CommandBar
        onCommand={openNew}
        onClaude={(sys) => openNew(sys || null, 'ai', null, 'anthropic')}
        onAI={(provider, sys) => openNew(sys || null, 'ai', null, provider)}
      />

      <div className="app-body-wrap">
        <main className="app-body">
          {sessions.map((session) => (
            <TerminalPanel
              key={session.id}
              session={session}
              wsUrl={WS_URL}
              active={session.id === activeId}
              onClose={() => closeSession(session.id)}
              onSessionId={(httpId) => handleSessionId(session.id, httpId)}
            />
          ))}
        </main>

        {telegramOpen && (
          <TelegramPanel
            onClose={() => setTelegramOpen(false)}
            onOpenSession={handleOpenSession}
          />
        )}

        {agentsOpen && (
          <AgentsPanel onClose={() => setAgentsOpen(false)} />
        )}

        {providersOpen && (
          <ProvidersPanel onClose={() => setProvidersOpen(false)} />
        )}
      </div>
    </div>
  );
}
