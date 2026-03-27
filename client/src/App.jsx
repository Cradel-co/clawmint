import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import {
  Terminal, MessageCircle, Send, BookUser, Settings,
  Plug, Bot, Sun, Moon, ChevronLeft, ChevronRight,
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

// ── Metadatos de secciones ────────────────────────────────────────────────────

const SECTION_META = {
  terminal: { Icon: Terminal,      label: 'Terminal'       },
  chat:     { Icon: MessageCircle, label: 'Chat IA'        },
  telegram: { Icon: Send,          label: 'Telegram'       },
  contacts: { Icon: BookUser,      label: 'Contactos'      },
  config:   { Icon: Settings,      label: 'Configuración'  },
};

const NAV_TOP = ['terminal', 'chat'];
const NAV_MID = ['telegram', 'contacts'];

const CONFIG_TABS = [
  { key: 'agents',    Icon: Bot,      label: 'Agentes'  },
  { key: 'providers', Icon: Settings, label: 'Providers' },
  { key: 'mcps',      Icon: Plug,     label: 'MCPs'     },
];

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ section, onSection, telegramBadge, expanded, onToggle }) {
  const renderItem = (key) => {
    const { Icon, label } = SECTION_META[key];
    return (
      <button
        key={key}
        className={`sidebar-item ${section === key ? 'active' : ''}`}
        onClick={() => onSection(key)}
        title={!expanded ? label : undefined}
        aria-label={label}
        aria-current={section === key ? 'page' : undefined}
      >
        <Icon size={18} aria-hidden="true" />
        <span className="sidebar-label">{label}</span>
        {key === 'telegram' && telegramBadge > 0 && (
          <span className="sidebar-badge" aria-label={`${telegramBadge} chats`}>{telegramBadge}</span>
        )}
      </button>
    );
  };

  return (
    <aside className={`app-sidebar${expanded ? ' sidebar-expanded' : ''}`} aria-label="Navegación principal">
      <nav className="sidebar-nav">
        {NAV_TOP.map(renderItem)}
        <div className="sidebar-divider" aria-hidden="true" />
        {NAV_MID.map(renderItem)}
      </nav>

      <div className="sidebar-bottom">
        <div className="sidebar-divider" aria-hidden="true" />
        {renderItem('config')}
        <button
          className="sidebar-item sidebar-toggle-btn"
          onClick={onToggle}
          title={expanded ? 'Colapsar sidebar' : 'Expandir sidebar'}
          aria-label={expanded ? 'Colapsar sidebar' : 'Expandir sidebar'}
        >
          {expanded
            ? <ChevronLeft  size={16} aria-hidden="true" />
            : <ChevronRight size={16} aria-hidden="true" />}
        </button>
      </div>
    </aside>
  );
}

// ── Barra de sección ──────────────────────────────────────────────────────────

function SectionBar({ section, telegramBadge }) {
  if (!['chat', 'telegram', 'contacts'].includes(section)) return null;
  const { Icon, label } = SECTION_META[section];
  return (
    <div className="section-bar">
      <Icon size={14} className="section-bar-icon" aria-hidden="true" />
      <span className="section-bar-title">{label}</span>
      {section === 'telegram' && telegramBadge > 0 && (
        <span className="section-bar-badge">{telegramBadge} chats</span>
      )}
    </div>
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
  const [mounted, setMounted]   = useState({ terminal: true });
  const [sessions, setSessions] = useState(() => { const s = createSession(); return [s]; });
  const [activeId, setActiveId] = useState(() => nextId);
  const [telegramChatsCount, setTelegramChatsCount] = useState(0);
  const [wsConnected, setWsConnected] = useState(true);
  const [sidebarExpanded, setSidebarExpanded] = useState(() => {
    try { return localStorage.getItem('sidebar-expanded') === 'true'; } catch { return false; }
  });

  const httpIdToTabId = useRef(new Map());

  // Cambia de sección y monta la sección si es la primera vez
  const handleSection = useCallback((key) => {
    setMounted(prev => prev[key] ? prev : { ...prev, [key]: true });
    setSection(key);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarExpanded(v => {
      const next = !v;
      try { localStorage.setItem('sidebar-expanded', String(next)); } catch {}
      return next;
    });
  }, []);

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
    handleSection('terminal');
    return s;
  }, [handleSection]);

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

  const handleSessionId   = useCallback((frontendTabId, httpId) => { httpIdToTabId.current.set(httpId, frontendTabId); }, []);
  const handleOpenSession = useCallback((httpSessionId) => {
    const tabId = httpIdToTabId.current.get(httpSessionId);
    if (tabId) { setActiveId(tabId); } else { openNew(null, 'pty', httpSessionId); }
    handleSection('terminal');
  }, [openNew, handleSection]);

  const toTerminal = useCallback(() => handleSection('terminal'), [handleSection]);

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
          onSection={handleSection}
          telegramBadge={telegramChatsCount}
          expanded={sidebarExpanded}
          onToggle={toggleSidebar}
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

          {/* ── Chat IA — montado en primer acceso, persiste con CSS ── */}
          {mounted.chat && (
            <div className={`section section-full ${section === 'chat' ? 'section-active' : ''}`} aria-hidden={section !== 'chat'}>
              <SectionBar section="chat" telegramBadge={0} />
              <ErrorBoundary>
                <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                  <WebChatPanel onClose={toTerminal} embedded />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

          {/* ── Telegram — montado en primer acceso, persiste con CSS ── */}
          {mounted.telegram && (
            <div className={`section section-full ${section === 'telegram' ? 'section-active' : ''}`} aria-hidden={section !== 'telegram'}>
              <SectionBar section="telegram" telegramBadge={telegramChatsCount} />
              <ErrorBoundary>
                <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                  <TelegramPanel onClose={toTerminal} onOpenSession={handleOpenSession} embedded />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

          {/* ── Contactos — montado en primer acceso, persiste con CSS ── */}
          {mounted.contacts && (
            <div className={`section section-full ${section === 'contacts' ? 'section-active' : ''}`} aria-hidden={section !== 'contacts'}>
              <SectionBar section="contacts" telegramBadge={0} />
              <ErrorBoundary>
                <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                  <ContactsPanel onClose={toTerminal} embedded />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

          {/* ── Config — montado en primer acceso, persiste con CSS ── */}
          {mounted.config && (
            <div className={`section section-full ${section === 'config' ? 'section-active' : ''}`} aria-hidden={section !== 'config'}>
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
          { key: 'terminal', Icon: Terminal,      label: 'Terminal' },
          { key: 'chat',     Icon: MessageCircle, label: 'Chat'     },
          { key: 'telegram', Icon: Send,          label: 'TG'       },
          { key: 'contacts', Icon: BookUser,      label: 'Contactos' },
          { key: 'config',   Icon: Settings,      label: 'Config'   },
        ].map(({ key, Icon, label }) => (
          <button
            key={key}
            className={section === key ? 'active' : ''}
            onClick={() => handleSection(key)}
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
