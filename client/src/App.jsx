import { useState, useCallback, useRef, useEffect, useReducer, lazy, Suspense } from 'react';
import { MessageCircle, Settings, Plug, Users, Bot, Sun, Moon, Terminal } from 'lucide-react';
import TabBar from './components/TabBar.jsx';
import CommandBar from './components/CommandBar.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Skeleton from './components/Skeleton.jsx';
import ReconnectBanner from './components/ReconnectBanner.jsx';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { ThemeProvider, useTheme } from './contexts/ThemeContext.jsx';
import { ToastProvider } from './contexts/ToastContext.jsx';
import { API_BASE, WS_URL } from './config';
import { apiFetch } from './authUtils';
import './App.css';
import './components/AgentsPanel.css';
import './components/TelegramPanel.css';
import './components/WebChatPanel.css';
import './components/ProvidersPanel.css';

// Lazy-load paneles que se abren bajo demanda
const TerminalPanel = lazy(() => import('./components/TerminalPanel.jsx'));
const TelegramPanel = lazy(() => import('./components/TelegramPanel.jsx'));
const AgentsPanel = lazy(() => import('./components/AgentsPanel.jsx'));
const ProvidersPanel = lazy(() => import('./components/ProvidersPanel.jsx'));
const McpsPanel = lazy(() => import('./components/McpsPanel.jsx'));
const WebChatPanel = lazy(() => import('./components/WebChatPanel.jsx'));

let nextId = 0;

function createSession(command = null, type = 'pty', httpSessionId = null, provider = null) {
  const id = ++nextId;
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

// ── Panel reducer: reemplaza 5 booleans por un estado único ──────────────────

function panelReducer(state, action) {
  switch (action.type) {
    case 'toggle':
      return state === action.panel ? null : action.panel;
    case 'close':
      return null;
    default:
      return state;
  }
}

const PANELS = [
  { key: 'chat', icon: MessageCircle, label: 'Chat con IA' },
  { key: 'providers', icon: Settings, label: 'Providers de IA' },
  { key: 'mcps', icon: Plug, label: 'MCPs' },
  { key: 'agents', icon: Users, label: 'Agentes personalizados' },
  { key: 'telegram', icon: Bot, label: 'Panel de Telegram' },
];

function AppContent() {
  const { theme, toggleTheme } = useTheme();

  const [sessions, setSessions] = useState(() => {
    const initial = createSession();
    return [initial];
  });
  const [activeId, setActiveId] = useState(() => nextId);
  const [activePanel, dispatchPanel] = useReducer(panelReducer, null);
  const [telegramChatsCount, setTelegramChatsCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(true);

  // Mapa: httpSessionId → frontendTabId
  const httpIdToTabId = useRef(new Map());

  // WebSocket listener para eventos de Telegram (abre pestañas automáticamente)
  useEffect(() => {
    let ws;
    let reconnectTimer;

    function connect() {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        setWsConnected(true);
        ws.send(JSON.stringify({ type: 'init', sessionType: 'listener' }));
      };
      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => {};
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'telegram_session') {
            const { sessionId, from } = msg;
            if (httpIdToTabId.current.has(sessionId)) {
              setActiveId(httpIdToTabId.current.get(sessionId));
              return;
            }
            setSessions((prev) => {
              const s = createSession(null, 'pty', sessionId);
              s.title = `TG: ${from}`;
              setActiveId(s.id);
              return [...prev, s];
            });
          }
        } catch { /* silenciar */ }
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Obtener cantidad de chats activos del bot para el badge
  useEffect(() => {
    if (activePanel === 'telegram') return;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/telegram/bots`);
        const bots = await res.json();
        const chats = Array.isArray(bots)
          ? bots.reduce((n, b) => n + (b.chats?.length || 0), 0)
          : 0;
        setTelegramChatsCount(chats);
      } catch { /* silenciar — polling en background */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [activePanel]);

  const openNew = useCallback((command = null, type = 'pty', httpSessionId = null, provider = null) => {
    const session = createSession(command, type, httpSessionId, provider);
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
    return session;
  }, []);

  const closeSession = useCallback((id) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      for (const [httpId, tabId] of httpIdToTabId.current) {
        if (tabId === id) { httpIdToTabId.current.delete(httpId); break; }
      }
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

  const handleSessionId = useCallback((frontendTabId, httpId) => {
    httpIdToTabId.current.set(httpId, frontendTabId);
  }, []);

  const handleOpenSession = useCallback((httpSessionId) => {
    const tabId = httpIdToTabId.current.get(httpSessionId);
    if (tabId) {
      setActiveId(tabId);
      dispatchPanel({ type: 'close' });
    } else {
      openNew(null, 'pty', httpSessionId);
      dispatchPanel({ type: 'close' });
    }
  }, [openNew]);

  return (
    <div className="app">
      <a href="#terminal-main" className="skip-link">Ir al contenido principal</a>

      <ReconnectBanner connected={wsConnected} />

      <header className="app-header">
        <span className="dot red" aria-hidden="true" />
        <span className="dot yellow" aria-hidden="true" />
        <span className="dot green" aria-hidden="true" />
        <h1 className="title">Terminal Live</h1>

        <nav className="header-right" aria-label="Paneles">
          <button
            className="telegram-btn theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          >
            {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
          </button>

          {PANELS.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              className={`telegram-btn ${activePanel === key ? 'active' : ''}`}
              onClick={() => dispatchPanel({ type: 'toggle', panel: key })}
              aria-label={label}
              aria-pressed={activePanel === key}
            >
              <Icon size={16} aria-hidden="true" />
              {key === 'telegram' && telegramChatsCount > 0 && activePanel !== 'telegram' && (
                <span className="telegram-badge">{telegramChatsCount}</span>
              )}
            </button>
          ))}
        </nav>
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
        <main id="terminal-main" className="app-body">
          <Suspense fallback={<Skeleton lines={5} style={{ padding: '24px' }} />}>
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
          </Suspense>
        </main>

        <Suspense fallback={<Skeleton lines={4} style={{ width: 380, padding: '16px' }} />}>
          <ErrorBoundary>
            {activePanel === 'telegram' && (
              <TelegramPanel
                onClose={() => dispatchPanel({ type: 'close' })}
                onOpenSession={handleOpenSession}
              />
            )}

            {activePanel === 'agents' && (
              <AgentsPanel onClose={() => dispatchPanel({ type: 'close' })} />
            )}

            {activePanel === 'providers' && (
              <ProvidersPanel onClose={() => dispatchPanel({ type: 'close' })} />
            )}

            {activePanel === 'mcps' && (
              <McpsPanel onClose={() => dispatchPanel({ type: 'close' })} />
            )}

            {activePanel === 'chat' && (
              <WebChatPanel onClose={() => dispatchPanel({ type: 'close' })} />
            )}
          </ErrorBoundary>
        </Suspense>
      </div>

      {/* Mobile bottom nav — visible solo en <640px */}
      <nav className="mobile-bottom-nav" aria-label="Navegación móvil">
        <button
          className={activePanel === null ? 'active' : ''}
          onClick={() => dispatchPanel({ type: 'close' })}
        >
          <Terminal size={20} aria-hidden="true" />
          <span>Terminal</span>
        </button>
        {PANELS.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            className={activePanel === key ? 'active' : ''}
            onClick={() => dispatchPanel({ type: 'toggle', panel: key })}
            aria-label={label}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{key === 'chat' ? 'Chat' : key === 'telegram' ? 'TG' : key.slice(0, 4)}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
