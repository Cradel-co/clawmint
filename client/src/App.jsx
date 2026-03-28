import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import {
  Terminal, MessageCircle, Send, BookUser, Settings,
  Plug, Bot, Gauge, Sun, Moon, ChevronLeft, ChevronRight,
  PanelsLeftRight, LogIn,
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
import { WS_URL } from './config';
import './App.css';

const TerminalPanel  = lazy(() => import('./components/TerminalPanel.jsx'));
const TelegramPanel  = lazy(() => import('./components/TelegramPanel.jsx'));
const AgentsPanel    = lazy(() => import('./components/AgentsPanel.jsx'));
const ProvidersPanel = lazy(() => import('./components/ProvidersPanel.jsx'));
const McpsPanel      = lazy(() => import('./components/McpsPanel.jsx'));
const WebChatPanel   = lazy(() => import('./components/WebChatPanel.jsx'));
const ContactsPanel  = lazy(() => import('./components/ContactsPanel.jsx'));
const LimitsPanel    = lazy(() => import('./components/LimitsPanel.jsx'));

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
  { key: 'limits',    Icon: Gauge,    label: 'Límites'  },
];

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({ section, onSection, chatBadge, telegramBadge, expanded, onToggle }) {
  const renderItem = (key) => {
    const { Icon, label } = SECTION_META[key];
    const badge = key === 'telegram' ? telegramBadge : key === 'chat' ? chatBadge : 0;
    return (
      <button
        key={key}
        className={`sidebar-item sidebar-item-${key} ${section === key ? 'active' : ''}`}
        onClick={() => onSection(key)}
        title={!expanded ? label : undefined}
        aria-label={label}
        aria-current={section === key ? 'page' : undefined}
      >
        <Icon size={18} aria-hidden="true" />
        <span className="sidebar-label">{label}</span>
        {badge > 0 && (
          <span className="sidebar-badge" aria-label={`${badge} nuevos`}>{badge > 99 ? '99+' : badge}</span>
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

function SectionBar({ section }) {
  if (!['chat', 'telegram', 'contacts'].includes(section)) return null;
  const { Icon, label } = SECTION_META[section];
  return (
    <div className="section-bar">
      <Icon size={14} className="section-bar-icon" aria-hidden="true" />
      <span className="section-bar-title">{label}</span>
    </div>
  );
}

// ── Context bar (terminal section) ───────────────────────────────────────────

function ContextBar({ splitMode, onToggleSplit, chatState }) {
  return (
    <div className="context-bar">
      {splitMode && chatState.cwd && (
        <span className="context-cwd" title={chatState.cwd}>📁 {chatState.cwd}</span>
      )}
      {splitMode && chatState.provider && (
        <span className="context-provider">⚡ {chatState.provider}</span>
      )}
      <span className="context-spacer" />
      <button
        className={`split-toggle-btn${splitMode ? ' active' : ''}`}
        onClick={onToggleSplit}
        title={splitMode ? 'Cerrar split' : 'Abrir split con Chat IA'}
        aria-label={splitMode ? 'Cerrar modo split' : 'Abrir modo split'}
      >
        <PanelsLeftRight size={13} aria-hidden="true" />
        <span>{splitMode ? 'Cerrar split' : 'Split'}</span>
      </button>
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
            {tab === 'limits'    && <LimitsPanel    onClose={null} embedded />}
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}

// ── App principal ─────────────────────────────────────────────────────────────

function AppContent() {
  const { theme, toggleTheme } = useTheme();
  const { user, setShowAuthPanel } = useAuth();

  const [section, setSection]   = useState('terminal');
  const [mounted, setMounted]   = useState({ terminal: true });
  const [sessions, setSessions] = useState(() => { const s = createSession(); return [s]; });
  const [activeId, setActiveId] = useState(() => nextId);
  const [chatBadge, setChatBadge]         = useState(0);
  const [telegramBadge, setTelegramBadge] = useState(0);
  const [wsConnected, setWsConnected] = useState(true);
  const [sidebarExpanded, setSidebarExpanded] = useState(() => {
    try { return localStorage.getItem('sidebar-expanded') === 'true'; } catch { return false; }
  });

  // ── Split mode ───────────────────────────────────────────────────────────────
  const [splitMode, setSplitMode] = useState(() => {
    try { return localStorage.getItem('split-mode') === 'true'; } catch { return false; }
  });
  const [splitRatio, setSplitRatioState] = useState(() => {
    try { return parseFloat(localStorage.getItem('split-ratio')) || 55; } catch { return 55; }
  });
  const [splitChatState, setSplitChatState] = useState({ cwd: '~', provider: 'anthropic' });

  const splitRatioRef     = useRef(splitRatio);
  const splitContainerRef = useRef(null);

  const setSplitRatio = useCallback((v) => {
    splitRatioRef.current = v;
    setSplitRatioState(v);
  }, []);

  const toggleSplit = useCallback(() => {
    setSplitMode(v => {
      const next = !v;
      try { localStorage.setItem('split-mode', String(next)); } catch {}
      return next;
    });
  }, []);

  const onSplitMouseDown = useCallback((e) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const onMove = (ev) => {
      const rect = container.getBoundingClientRect();
      const ratio = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
      setSplitRatio(ratio);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem('split-ratio', String(splitRatioRef.current)); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [setSplitRatio]);

  const handleSplitChatStateChange = useCallback(({ cwd, provider }) => {
    setSplitChatState(prev => ({
      cwd:      cwd      !== undefined ? cwd      : prev.cwd,
      provider: provider !== undefined ? provider : prev.provider,
    }));
  }, []);

  // ── Resto del estado ─────────────────────────────────────────────────────────

  const httpIdToTabId = useRef(new Map());
  const sectionRef    = useRef('terminal');

  const handleSection = useCallback((key) => {
    setMounted(prev => prev[key] ? prev : { ...prev, [key]: true });
    setSection(key);
    sectionRef.current = key;
    if (key === 'chat')     setChatBadge(0);
    if (key === 'telegram') setTelegramBadge(0);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarExpanded(v => {
      const next = !v;
      try { localStorage.setItem('sidebar-expanded', String(next)); } catch {}
      return next;
    });
  }, []);

  const handleNewChatMessage = useCallback(() => {
    if (sectionRef.current !== 'chat') setChatBadge(b => b + 1);
  }, []);

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
            if (sectionRef.current !== 'telegram') setTelegramBadge(b => b + 1);
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
        <h1 className="title"><span>Claw</span><em>mint</em></h1>
        <span
          className={`ws-status-dot${wsConnected ? '' : ' disconnected'}`}
          title={wsConnected ? 'Conectado' : 'Sin conexión'}
          aria-label={wsConnected ? 'Servidor conectado' : 'Sin conexión al servidor'}
        />

        <div className="header-right">
          {user ? (
            <div className="header-user" aria-label={`Usuario: ${user.name}`}>
              <span className="header-user-avatar">{(user.name || 'U')[0].toUpperCase()}</span>
              <span className="header-user-name">{user.name}</span>
            </div>
          ) : (
            <button
              className="header-icon-btn header-login-btn"
              onClick={() => setShowAuthPanel(true)}
              aria-label="Iniciar sesión"
            >
              <LogIn size={14} aria-hidden="true" />
              <span className="header-login-label">Entrar</span>
            </button>
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
          chatBadge={chatBadge}
          telegramBadge={telegramBadge}
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
            <ContextBar
              splitMode={splitMode}
              onToggleSplit={toggleSplit}
              chatState={splitChatState}
            />

            {/* ── Split layout ── */}
            <div className={splitMode ? 'split-layout' : 'terminal-body'} ref={splitContainerRef}>

              {/* Panel izquierdo: Terminal */}
              <main className={splitMode ? 'split-panel' : 'terminal-main'} style={splitMode ? { width: `${splitRatio}%` } : undefined}>
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

              {/* Divisor + panel derecho: Chat IA (solo en split mode) */}
              {splitMode && (
                <>
                  <div
                    className="split-divider"
                    onMouseDown={onSplitMouseDown}
                    role="separator"
                    aria-label="Divisor redimensionable"
                    aria-orientation="vertical"
                  />
                  <div className="split-panel split-chat-panel" style={{ width: `${100 - splitRatio}%` }}>
                    <ErrorBoundary>
                      <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                        <WebChatPanel
                          embedded
                          onNewMessage={handleNewChatMessage}
                          onStateChange={handleSplitChatStateChange}
                        />
                      </Suspense>
                    </ErrorBoundary>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── Chat IA — montado en primer acceso, persiste con CSS ── */}
          {mounted.chat && (
            <div className={`section section-full ${section === 'chat' ? 'section-active' : ''}`} aria-hidden={section !== 'chat'}>
              <SectionBar section="chat" />
              <ErrorBoundary>
                <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                  <WebChatPanel onClose={toTerminal} embedded onNewMessage={handleNewChatMessage} />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}

          {/* ── Telegram — montado en primer acceso, persiste con CSS ── */}
          {mounted.telegram && (
            <div className={`section section-full ${section === 'telegram' ? 'section-active' : ''}`} aria-hidden={section !== 'telegram'}>
              <SectionBar section="telegram" />
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
              <SectionBar section="contacts" />
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
          { key: 'chat',     Icon: MessageCircle, label: 'Chat',     badge: chatBadge     },
          { key: 'telegram', Icon: Send,          label: 'TG',       badge: telegramBadge },
          { key: 'contacts', Icon: BookUser,      label: 'Contactos' },
          { key: 'config',   Icon: Settings,      label: 'Config'   },
        ].map(({ key, Icon, label, badge }) => (
          <button
            key={key}
            className={section === key ? 'active' : ''}
            onClick={() => handleSection(key)}
            aria-label={label}
          >
            <span className="mobile-nav-icon">
              <Icon size={20} aria-hidden="true" />
              {badge > 0 && <span className="mobile-nav-badge">{badge > 99 ? '99+' : badge}</span>}
            </span>
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
