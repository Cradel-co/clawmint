import { useCallback, useRef, useEffect, useState, useMemo, lazy, Suspense } from 'react';
import TabBar from './components/TabBar.jsx';
import CommandBar from './components/CommandBar.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Skeleton from './components/Skeleton.jsx';
import ReconnectBanner from './components/ReconnectBanner.jsx';
import AuthPanel from './components/AuthPanel.jsx';
import WelcomeWizard from './components/WelcomeWizard.jsx';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import { useUIStore } from './stores/uiStore';
import { useSessionStore } from './stores/sessionStore';
import { initListenerWs } from './lib/listenerWs';
import { WS_URL, fetchServerStatus } from './config';
import { isFeature } from './hooks/useFeatureFlag';
import { useKeybindings } from './hooks/useKeybindings';
import { getStoredTokens } from './authUtils';
import { CommandPalette } from './components/ux';

import AppHeader from './components/layout/AppHeader';
import Sidebar from './components/layout/Sidebar';
import SectionBar from './components/layout/SectionBar';
import ContextBar from './components/layout/ContextBar';
import MobileNav from './components/layout/MobileNav';
import StatusFooter from './components/layout/StatusFooter';
import ConfigSection from './components/ConfigSection';

import styles from './App.module.css';

const SECTION_CLASS = {
  dashboard: styles.sectionDashboard,
  chat: styles.sectionChat,
  telegram: styles.sectionTelegram,
  contacts: styles.sectionContacts,
  tasks: styles.sectionTasks,
  scheduler: styles.sectionScheduler,
  skills: styles.sectionSkills,
  integrations: styles.sectionIntegrations,
  devices: styles.sectionDevices,
  music: styles.sectionMusic,
  config: styles.sectionConfig,
};

const Dashboard         = lazy(() => import('./components/Dashboard.jsx'));
const TerminalPanel     = lazy(() => import('./components/TerminalPanel.jsx'));
const TelegramPanel     = lazy(() => import('./components/TelegramPanel.jsx'));
const WebChatPanel      = lazy(() => import('./components/WebChatPanel.jsx'));
const ContactsPanel     = lazy(() => import('./components/ContactsPanel.jsx'));
const HouseholdPanel    = lazy(() => import('./components/HouseholdPanel.jsx'));
const TasksPanel        = lazy(() => import('./components/features/TasksPanel.jsx'));
const SchedulerPanel    = lazy(() => import('./components/features/SchedulerPanel.jsx'));
const SkillsPanel       = lazy(() => import('./components/features/SkillsPanel.jsx'));
const IntegrationsPanel = lazy(() => import('./components/features/IntegrationsPanel.jsx'));
const DevicesPanel      = lazy(() => import('./components/features/DevicesPanel.jsx'));
const MusicPanel        = lazy(() => import('./components/features/MusicPanel.jsx'));

// ── App principal ─────────────────────────────────────────────────────────────

function AppContent() {
  const { user, handleAuth } = useAuth();
  const [firstRun, setFirstRun] = useState(null); // null=loading, true=mostrar wizard, false=flow normal

  // Detectar first-run al montar: si el server dice firstRun:true y no hay user,
  // mostramos el wizard. Retry cada 2s por si el server aún está arrancando.
  useEffect(() => {
    if (user) { setFirstRun(false); return; }
    let cancelled = false;
    let retries = 0;
    const poll = async () => {
      try {
        const status = await fetchServerStatus();
        if (!cancelled) setFirstRun(!!status.firstRun);
      } catch {
        if (cancelled) return;
        retries++;
        if (retries < 15) setTimeout(poll, 2000); // hasta 30s de boot
        else setFirstRun(false); // fallback a login normal
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [user]);

  const handleWizardComplete = (auth) => {
    if (auth) handleAuth(auth);
    setFirstRun(false);
  };
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

  // ── Fase D: command palette global + keybindings ─────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  const accessToken = useMemo(() => getStoredTokens()?.accessToken, [user]);
  const commandPaletteEnabled = isFeature('COMMAND_PALETTE');

  // Actions del command palette + keybindings
  const appActions = {
    openCommandPalette: () => setPaletteOpen(true),
    newSession:         () => openNewAndSwitch(),
    goDashboard:        () => setSection('dashboard'),
    goTerminal:         () => setSection('terminal'),
    goChat:             () => setSection('chat'),
    goTelegram:         () => setSection('telegram'),
    goContacts:         () => setSection('contacts'),
    goConfig:           () => setSection('config'),
  };
  useKeybindings(accessToken, appActions);

  const paletteCommands = useMemo(() => ([
    { id: 'nav:dashboard', title: 'Ir a Dashboard',   group: 'nav', icon: '◉',                          action: () => setSection('dashboard') },
    { id: 'nav:terminal',  title: 'Ir a Terminal',    group: 'nav', icon: '⌨', keywords: ['pty'],      action: () => setSection('terminal') },
    { id: 'nav:chat',      title: 'Ir a Chat IA',     group: 'nav', icon: '✦', keywords: ['ai'],       action: () => setSection('chat') },
    { id: 'nav:telegram',  title: 'Ir a Telegram',    group: 'nav', icon: '✈', keywords: ['bots'],     action: () => setSection('telegram') },
    { id: 'nav:contacts',  title: 'Ir a Contactos',   group: 'nav', icon: '☺',                          action: () => setSection('contacts') },
    { id: 'nav:config',    title: 'Ir a Configuración', group: 'nav', icon: '⚙',                        action: () => setSection('config') },
    { id: 'act:new',       title: 'Nueva sesión PTY', group: 'actions', icon: '+', hint: 'mod+n',      action: () => openNewAndSwitch() },
    { id: 'act:split',     title: 'Toggle split view', group: 'actions', icon: '⋮⋮',                    action: () => setSplitMode(!splitMode) },
  ]), [setSection, openNewAndSwitch, setSplitMode, splitMode]);

  // Gate: primer uso → welcome wizard. Si no hay user después, cae a AuthPanel.
  if (!user && firstRun === true) return <WelcomeWizard onComplete={handleWizardComplete} />;
  if (!user && firstRun === null) return null; // loading initial status
  if (!user) return <AuthPanel onAuth={handleAuth} onSkip={null} />;

  return (
    <div className={styles.app}>
      <a href="#app-main" className={styles.skipLink}>Ir al contenido principal</a>
      <ReconnectBanner connected={wsConnected} />
      {commandPaletteEnabled && (
        <CommandPalette commands={paletteCommands} open={paletteOpen} onOpenChange={setPaletteOpen} />
      )}
      <AppHeader />

      <div className={styles.appLayout}>
        <Sidebar />

        <div id="app-main" className={styles.appContent}>

          {/* ── Dashboard (landing) ── */}
          <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.dashboard} ${section === 'dashboard' ? styles.sectionActive : ''}`} aria-hidden={section !== 'dashboard'}>
            <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
              <Dashboard />
            </Suspense></ErrorBoundary>
          </div>

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

          {mounted.household && (
            <div className={`${styles.section} ${styles.sectionFull} ${section === 'household' ? styles.sectionActive : ''}`} aria-hidden={section !== 'household'}>
              <SectionBar section="household" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <HouseholdPanel />
              </Suspense></ErrorBoundary>
            </div>
          )}

          {mounted.tasks && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.tasks} ${section === 'tasks' ? styles.sectionActive : ''}`} aria-hidden={section !== 'tasks'}>
              <SectionBar section="tasks" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <TasksPanel accessToken={accessToken} />
              </Suspense></ErrorBoundary>
            </div>
          )}

          {mounted.scheduler && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.scheduler} ${section === 'scheduler' ? styles.sectionActive : ''}`} aria-hidden={section !== 'scheduler'}>
              <SectionBar section="scheduler" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <SchedulerPanel accessToken={accessToken} />
              </Suspense></ErrorBoundary>
            </div>
          )}

          {mounted.skills && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.skills} ${section === 'skills' ? styles.sectionActive : ''}`} aria-hidden={section !== 'skills'}>
              <SectionBar section="skills" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <SkillsPanel accessToken={accessToken} />
              </Suspense></ErrorBoundary>
            </div>
          )}

          {mounted.integrations && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.integrations} ${section === 'integrations' ? styles.sectionActive : ''}`} aria-hidden={section !== 'integrations'}>
              <SectionBar section="integrations" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <IntegrationsPanel accessToken={accessToken} />
              </Suspense></ErrorBoundary>
            </div>
          )}

          {mounted.devices && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.devices} ${section === 'devices' ? styles.sectionActive : ''}`} aria-hidden={section !== 'devices'}>
              <SectionBar section="devices" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <DevicesPanel accessToken={accessToken} />
              </Suspense></ErrorBoundary>
            </div>
          )}

          {mounted.music && (
            <div className={`${styles.section} ${styles.sectionFull} ${SECTION_CLASS.music} ${section === 'music' ? styles.sectionActive : ''}`} aria-hidden={section !== 'music'}>
              <SectionBar section="music" />
              <ErrorBoundary><Suspense fallback={<Skeleton lines={6} style={{ padding: '24px' }} />}>
                <MusicPanel accessToken={accessToken} />
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

      <StatusFooter />
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
