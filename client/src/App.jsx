import { useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import TabBar from './components/TabBar.jsx';
import CommandBar from './components/CommandBar.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Skeleton from './components/Skeleton.jsx';
import ReconnectBanner from './components/ReconnectBanner.jsx';
import AuthPanel from './components/AuthPanel.jsx';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import { useUIStore } from './stores/uiStore';
import { useSessionStore } from './stores/sessionStore';
import { initListenerWs } from './lib/listenerWs';
import { WS_URL } from './config';

import AppHeader from './components/layout/AppHeader';
import Sidebar from './components/layout/Sidebar';
import SectionBar from './components/layout/SectionBar';
import ContextBar from './components/layout/ContextBar';
import MobileNav from './components/layout/MobileNav';
import ConfigSection from './components/ConfigSection';

import styles from './App.module.css';

const SECTION_CLASS = { chat: styles.sectionChat, telegram: styles.sectionTelegram, contacts: styles.sectionContacts, config: styles.sectionConfig };

const TerminalPanel  = lazy(() => import('./components/TerminalPanel.jsx'));
const TelegramPanel  = lazy(() => import('./components/TelegramPanel.jsx'));
const WebChatPanel   = lazy(() => import('./components/WebChatPanel.jsx'));
const ContactsPanel  = lazy(() => import('./components/ContactsPanel.jsx'));

// ── App principal ─────────────────────────────────────────────────────────────

function AppContent() {
  const { user, handleAuth } = useAuth();
  const { section, setSection, mounted, splitMode, setSplitMode, splitRatio, setSplitRatio, wsConnected, incrementChatBadge, setSplitChatState } = useUIStore();
  const { sessions, activeId, setActiveId, openNew, closeSession, handleSessionId, handleOpenSession } = useSessionStore();

  const splitRatioRef     = useRef(splitRatio);
  const splitContainerRef = useRef(null);

  // WS Listener global (reconexión automática)
  useEffect(() => initListenerWs(), []);

  // Desactivar split mode en mobile
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e) => { if (e.matches) setSplitMode(false); };
    if (mq.matches) setSplitMode(false);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [setSplitMode]);

  const onSplitPointerDown = useCallback((e) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    e.target.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const rect = container.getBoundingClientRect();
      const ratio = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
      splitRatioRef.current = ratio;
      setSplitRatio(ratio);
    };
    const onUp = () => {
      e.target.removeEventListener('pointermove', onMove);
      e.target.removeEventListener('pointerup', onUp);
    };
    e.target.addEventListener('pointermove', onMove);
    e.target.addEventListener('pointerup', onUp);
  }, [setSplitRatio]);

  const handleSplitChatStateChange = useCallback(({ cwd, provider }) => {
    setSplitChatState({
      ...(cwd !== undefined ? { cwd } : {}),
      ...(provider !== undefined ? { provider } : {}),
    });
  }, [setSplitChatState]);

  const handleNewChatMessage = useCallback(() => {
    if (useUIStore.getState().section !== 'chat') incrementChatBadge();
  }, [incrementChatBadge]);

  const openNewAndSwitch = useCallback((command = null, type = 'pty', httpSessionId = null, provider = null) => {
    openNew(command, type, httpSessionId, provider);
    setSection('terminal');
  }, [openNew, setSection]);

  const handleOpenSessionAndSwitch = useCallback((httpSessionId) => {
    handleOpenSession(httpSessionId);
    setSection('terminal');
  }, [handleOpenSession, setSection]);

  const toTerminal = useCallback(() => setSection('terminal'), [setSection]);

  // Gate: requiere autenticación
  if (!user) return <AuthPanel onAuth={handleAuth} onSkip={null} />;

  return (
    <div className={styles.app}>
      <a href="#app-main" className={styles.skipLink}>Ir al contenido principal</a>
      <ReconnectBanner connected={wsConnected} />
      <AppHeader />

      <div className={styles.appLayout}>
        <Sidebar />

        <div id="app-main" className={styles.appContent}>

          {/* ── Terminal ── */}
          <div className={`${styles.section} ${styles.sectionTerminal} ${section === 'terminal' ? styles.sectionActive : ''}`} aria-hidden={section !== 'terminal'}>
            <TabBar sessions={sessions} activeId={activeId} onSelect={setActiveId} onClose={closeSession} onNew={() => openNewAndSwitch()} />
            <CommandBar
              onCommand={openNewAndSwitch}
              onClaude={(sys) => openNewAndSwitch(sys || null, 'ai', null, 'anthropic')}
              onAI={(provider, sys) => openNewAndSwitch(sys || null, 'ai', null, provider)}
            />
            <ContextBar />

            <div className={splitMode ? styles.splitLayout : styles.terminalBody} ref={splitContainerRef}>
              <main className={splitMode ? styles.splitPanel : styles.terminalMain} style={splitMode ? { width: `${splitRatio}%` } : undefined}>
                <Suspense fallback={<Skeleton lines={5} style={{ padding: '24px' }} />}>
                  {sessions.map((s) => (
                    <TerminalPanel key={s.id} session={s} wsUrl={WS_URL} active={s.id === activeId}
                      onClose={() => closeSession(s.id)} onSessionId={(httpId) => handleSessionId(s.id, httpId)} />
                  ))}
                </Suspense>
              </main>

              {splitMode && (
                <>
                  <div className={styles.splitDivider} onPointerDown={onSplitPointerDown} role="separator"
                    aria-label="Divisor redimensionable" aria-orientation="vertical" />
                  <div className={`${styles.splitPanel} ${styles.splitChatPanel}`} style={{ width: `${100 - splitRatio}%` }}>
                    <ErrorBoundary>
                      <Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                        <WebChatPanel embedded onNewMessage={handleNewChatMessage} onStateChange={handleSplitChatStateChange} />
                      </Suspense>
                    </ErrorBoundary>
                  </div>
                </>
              )}
            </div>
          </div>

          {mounted.chat && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.chat} ${section === 'chat' ? styles.sectionActive : ''}`} aria-hidden={section !== 'chat'}>
              <SectionBar section="chat" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <WebChatPanel onClose={toTerminal} embedded onNewMessage={handleNewChatMessage} />
              </Suspense></ErrorBoundary>
            </div>
          )}

          {mounted.telegram && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.telegram} ${section === 'telegram' ? styles.sectionActive : ''}`} aria-hidden={section !== 'telegram'}>
              <SectionBar section="telegram" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <TelegramPanel onClose={toTerminal} onOpenSession={handleOpenSessionAndSwitch} embedded />
              </Suspense></ErrorBoundary>
            </div>
          )}

          {mounted.contacts && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.contacts} ${section === 'contacts' ? styles.sectionActive : ''}`} aria-hidden={section !== 'contacts'}>
              <SectionBar section="contacts" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <ContactsPanel onClose={toTerminal} embedded />
              </Suspense></ErrorBoundary>
            </div>
          )}

          {mounted.config && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.config} ${section === 'config' ? styles.sectionActive : ''}`} aria-hidden={section !== 'config'}>
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <ConfigSection onBack={toTerminal} />
              </Suspense></ErrorBoundary>
            </div>
          )}

        </div>
      </div>

      <MobileNav />
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
