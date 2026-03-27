import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import {
  Terminal, MessageCircle, Send, Users, BookUser, Settings,
  Plug, Bot, Sun, Moon,
} from 'lucide-react';
import TabBar from './components/TabBar.jsx';
import CommandBar from './components/CommandBar.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Skeleton from './components/Skeleton.jsx';
import ReconnectBanner from './components/ReconnectBanner.jsx';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { ThemeProvider, useTheme } from './contexts/ThemeContext.jsx';
import { ToastProvider } from './contexts/ToastContext.jsx';
import { useAuth } from './contexts/AuthContext.jsx';
import { API_BASE, WS_URL } from './config';
import { apiFetch } from './authUtils';
import './App.css';

const TerminalPanel  = lazy(() => import('./components/TerminalPanel.jsx'));
const TelegramPanel  = lazy(() => import('./components/TelegramPanel.jsx'));
const AgentsPanel    = lazy(() => import('./components/AgentsPanel.jsx'));
const ProvidersPanel = lazy(() => import('./components/ProvidersPanel.jsx'));
const McpsPanel      = lazy(() => import('./components/McpsPanel.jsx'));
const WebChatPanel   = lazy(() => import('./components/WebChatPanel.jsx'));
const ContactsPanel  = lazy(() => import('./components/ContactsPanel.jsx'));

let nextId = 0;

function createSession(command = null, type = 'pty', httpSessionId = null, provider = null) {
  const id = ++nextId;
  let title;
  if (provider === 'gemini')          title = `Gemini ${id}`;
  else if (provider === 'openai')     title = `GPT ${id}`;
  else if (provider === 'anthropic' || type === 'claude') title = `Claude ${id}`;
  else if (command && command.startsWith('claude')) title = `CC ${id}`;
  else title = command ? command.split(' ')[0] : `bash ${id}`;
  return { id, title, command, type, httpSessionId, provider };
}

// ── Secciones de navegación ───────────────────────────────────────────────────

const NAV_TOP = [
  { key: 'terminal',  Icon: Terminal,        label: 'Terminal' },
  { key: 'chat',      Icon: MessageCircle,   label: 'Chat' },
];
const NAV_MID = [
  { key: 'telegram',  Icon: Send,            label: 'Telegram' },
  { key: 'contacts',  Icon: BookUser,        label: 'Contactos' },
];
const CONFIG_TABS = [
  { key: 'agents',    Icon: Bot,             label: 'Agentes' },
  { key: 'providers', Icon: Settings,        label: 'Providers' },
  { key: 'mcps',      Icon: Plug,            label: 'MCPs' },
];

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ section, onSection, telegramBadge }) {
  return (
    <aside className="app-sidebar" aria-label="Navegación principal">
      <nav className="sidebar-nav">
        {NAV_TOP.map(({ key, Icon, label }) => (
          <button
            key={key}
            className={`sidebar-item ${section === key ? 'active' : ''}`}
            onClick={() => onSection(key)}
            aria-label={label}
            aria-current={section === key ? 'page' : undefined}
          >
            <Icon size={18} aria-hidden="true" />
            <span className="sidebar-label">{label}</span>
          </button>
        ))}

        <div className="sidebar-divider" aria-hidden="true" />

        {NAV_MID.map(({ key, Icon, label }) => (
          <button
            key={key}
            className={`sidebar-item ${section === key ? 'active' : ''}`}
            onClick={() => onSection(key)}
            aria-label={label}
            aria-current={section === key ? 'page' : undefined}
          >
            <Icon size={18} aria-hidden="true" />
            <span className="sidebar-label">{label}</span>
            {key === 'telegram' && telegramBadge > 0 && (
              <span className="sidebar-badge" aria-label={`${telegramBadge} chats`}>{telegramBadge}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <div className="sidebar-divider" aria-hidden="true" />
        <button
          className={`sidebar-item ${section === 'config' ? 'active' : ''}`}
          onClick={() => onSection('config')}
          aria-label="Configuración"
          aria-current={section === 'config' ? 'page' : undefined}
        >
          <Settings size={18} aria-hidden="true" />
          <span className="sidebar-label">Config</span>
        </button>
      </div>
    </aside>
  );
}

// ── Config section — tabs internos ────────────────────────────────────────────

function ConfigSection() {
  const [tab, setTab] = useState('agents');
  return (
    <div className="section-config">
      <div className="config-tab-bar">
        {CONFIG_TABS.map(({ key, Icon, label }) => (
          <button
            key={key}
            className={`config-tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div className="config-tab-body">
        <ErrorBoundary>
          <Suspense fallback={<Skeleton lines={4} style={{ padding: '24px' }} />}>
            {tab === 'agents'    && <AgentsPanel    onClose={null} embedded />}
            {tab === 'providers' && <ProvidersPanel onClose={null} embedded />}
            {tab === 'mcps'      && <McpsPanel      onClose={null} embedded />}
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}

// ── App principal ─────────────────────────────────────────────────────────────

function AppContent() {
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();

  const [section, setSection]   = useState('terminal');
  const [sessions, setSessions] = useState(() => { const s = createSession(); return [s]; });
  const [activeId, setActiveId] = useState(() => nextId);
  const [telegramChatsCount, setTelegramChatsCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(true);

  const httpIdToTabId = useRef(new Map());

  // Listener WebSocket global (eventos de Telegram → nuevas tabs)
  useEffect(() => {
    let ws, reconnectTimer;
    function connect() {
      ws = new WebSocket(WS_URL);
      ws.onopen  = () => { setWsConnected(true);  ws.send(JSON.stringify({ type: 'init', sessionType: 'listener' })); };
      ws.onclose = () => { setWsConnected(false); reconnectTimer = setTimeout(connect, 3000); };
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
    return () => { clearTimeout(reconnectTimer); ws?.close(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling badge Telegram (solo cuando no está en la sección telegram)
  useEffect(() => {
    if (section === 'telegram') return;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/telegram/bots`);
        const bots = await res.json();
        const count = Array.isArray(bots) ? bots.reduce((n, b) => n + (b.chats?.length || 0), 0) : 0;
        setTelegramChatsCount(count);
      } catch { /* silenciar */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [section]);

  const openNew = useCallback((command = null, type = 'pty', httpSessionId = null, provider = null) => {
    const s = createSession(command, type, httpSessionId, provider);
    setSessions((prev) => [...prev, s]);
    setActiveId(s.id);
    setSection('terminal');
    return s;
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
      if (activeId === id) setActiveId(next[next.length - 1].id);
      return next;
    });
  }, [activeId]);

  const handleSessionId  = useCallback((frontendTabId, httpId) => { httpIdToTabId.current.set(httpId, frontendTabId); }, []);
  const handleOpenSession = useCallback((httpSessionId) => {
    const tabId = httpIdToTabId.current.get(httpSessionId);
    if (tabId) { setActiveId(tabId); } else { openNew(null, 'pty', httpSessionId); }
    setSection('terminal');
  }, [openNew]);

  const toTerminal = useCallback(() => setSection('terminal'), []);

  return (
    <div className="app">
      <a href="#app-main" className="skip-link">Ir al contenido principal</a>
      <ReconnectBanner connected={wsConnected} />

      {/* ── Header ── */}
      <header className="app-header">
        <span className="dot red"    aria-hidden="true" />
        <span className="dot yellow" aria-hidden="true" />
        <span className="dot green"  aria-hidden="true" />
        <h1 className="title">Clawmint</h1>

        <div className="header-right">
          {user && (
            <div className="header-user" aria-label={`Usuario: ${user.name}`}>
              <span className="header-user-avatar">{(user.name || 'U')[0].toUpperCase()}</span>
              <span className="header-user-name">{user.name}</span>
            </div>
          )}
          <button
            className="header-icon-btn theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          >
            {theme === 'dark'
              ? <Sun  size={16} aria-hidden="true" />
              : <Moon size={16} aria-hidden="true" />}
          </button>
        </div>
      </header>

      {/* ── Layout principal ── */}
      <div className="app-layout">
        <Sidebar
          section={section}
          onSection={setSection}
          telegramBadge={telegramChatsCount}
        />

        <div id="app-main" className="app-content">

          {/* ── Terminal ── */}
          <div className={`section section-terminal ${section === 'terminal' ? 'section-active' : ''}`} aria-hidden={section !== 'terminal'}>
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
            <main className="terminal-body">
              <Suspense fallback={<Skeleton lines={5} style={{ padding: '24px' }} />}>
                {sessions.map((s) => (
                  <TerminalPanel
                    key={s.id}
                    session={s}
                    wsUrl={WS_URL}
                    active={s.id === activeId}
                    onClose={() => closeSession(s.id)}
                    onSessionId={(httpId) => handleSessionId(s.id, httpId)}
                  />
                ))}
              </Suspense>
            </main>
          </div>

          {/* ── Chat IA ── */}
          {section === 'chat' && (
            <div className="section section-full section-active">
              <ErrorBoundary>
                <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                  <WebChatPanel onClose={toTerminal} embedded />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

          {/* ── Telegram ── */}
          {section === 'telegram' && (
            <div className="section section-full section-active">
              <ErrorBoundary>
                <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                  <TelegramPanel onClose={toTerminal} onOpenSession={handleOpenSession} embedded />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

          {/* ── Contactos ── */}
          {section === 'contacts' && (
            <div className="section section-full section-active">
              <ErrorBoundary>
                <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                  <ContactsPanel onClose={toTerminal} embedded />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

          {/* ── Config ── */}
          {section === 'config' && (
            <div className="section section-full section-active">
              <ErrorBoundary>
                <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                  <ConfigSection />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

        </div>
      </div>

      {/* ── Mobile bottom nav ── */}
      <nav className="mobile-bottom-nav" aria-label="Navegación móvil">
        {[
          { key: 'terminal',  Icon: Terminal,      label: 'Terminal' },
          { key: 'chat',      Icon: MessageCircle, label: 'Chat' },
          { key: 'telegram',  Icon: Send,          label: 'TG' },
          { key: 'contacts',  Icon: BookUser,      label: 'Contactos' },
          { key: 'config',    Icon: Settings,      label: 'Config' },
        ].map(({ key, Icon, label }) => (
          <button
            key={key}
            className={section === key ? 'active' : ''}
            onClick={() => setSection(key)}
            aria-label={label}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{label}</span>
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
