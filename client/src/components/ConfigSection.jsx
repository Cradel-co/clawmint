import { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import { ChevronLeft } from 'lucide-react';
import ErrorBoundary from './ErrorBoundary.jsx';
import Skeleton from './Skeleton.jsx';
import { CONFIG_TABS, EXTRA_CONFIG_TABS } from './layout/sectionMeta';
import { isFeature } from '../hooks/useFeatureFlag';
import { useAuth } from '../contexts/AuthContext';
import { useUIStore } from '../stores/uiStore';
import { getStoredTokens } from '../authUtils';
import styles from '../App.module.css';

// ── Paneles existentes ─────────────────────────────────────────────────────
const AgentsPanel      = lazy(() => import('./AgentsPanel.jsx'));
const ProvidersPanel   = lazy(() => import('./ProvidersPanel.jsx'));
const McpsPanel        = lazy(() => import('./McpsPanel.jsx'));
const LimitsPanel      = lazy(() => import('./LimitsPanel.jsx'));
const VoicePanel       = lazy(() => import('./VoicePanel.jsx'));
const TranscriberPanel = lazy(() => import('./TranscriberPanel.jsx'));
const NodrizaPanel     = lazy(() => import('./NodrizaPanel.jsx'));
const RemindersPanel   = lazy(() => import('./RemindersPanel.jsx'));
const MemoryPanel      = lazy(() => import('./MemoryPanel.jsx'));
const LogsPanel        = lazy(() => import('./LogsPanel.jsx'));
const ProfilePanel     = lazy(() => import('./ProfilePanel.jsx'));

// ── Paneles nuevos (Fases B/C/D/E) ─────────────────────────────────────────
const PermissionsPanel  = lazy(() => import('./admin/PermissionsPanel.jsx'));
const HooksPanel        = lazy(() => import('./admin/HooksPanel.jsx'));
const MetricsDashboard  = lazy(() => import('./admin/MetricsDashboard.jsx'));
const UsersPanel        = lazy(() => import('./admin/UsersPanel.jsx'));
const WorkspacesPanel   = lazy(() => import('./admin/WorkspacesPanel.jsx'));
const OAuthCredentialsPanel = lazy(() => import('./admin/OAuthCredentialsPanel.jsx'));

const TypedMemoryPanel  = lazy(() => import('./features/TypedMemoryPanel.jsx'));
const SessionsPanel     = lazy(() => import('./features/SessionsPanel.jsx'));
const McpOAuthWizard    = lazy(() => import('./features/McpOAuthWizard.jsx'));

const KeybindingsPanel  = lazy(() => import('./ux/KeybindingsPanel.jsx'));
const LogsStream        = lazy(() => import('./ux/LogsStream.jsx'));

const CompactionSettingsPanel = lazy(() => import('./advanced/CompactionSettingsPanel.jsx'));
const ModelTiersPanel         = lazy(() => import('./advanced/ModelTiersPanel.jsx'));
const ToolsFilterPanel        = lazy(() => import('./advanced/ToolsFilterPanel.jsx'));
const LSPStatusPanel          = lazy(() => import('./advanced/LSPStatusPanel.jsx'));
const OrchestrationPanel      = lazy(() => import('./advanced/OrchestrationPanel.jsx'));

// Mapping key → factory({ accessToken, userId, isAdmin }). Así cada panel recibe
// sólo los props que necesita sin inflar el componente actual.
const EXTRA_PANELS = {
  permissions:   ({ accessToken }) => <PermissionsPanel  accessToken={accessToken} />,
  hooks:         ({ accessToken }) => <HooksPanel        accessToken={accessToken} />,
  metrics:       ({ accessToken }) => <MetricsDashboard  accessToken={accessToken} />,
  users:         ({ accessToken, userId }) => <UsersPanel accessToken={accessToken} currentUserId={userId} />,
  workspaces:    ({ accessToken }) => <WorkspacesPanel   accessToken={accessToken} />,
  oauthCreds:    ({ accessToken }) => <OAuthCredentialsPanel accessToken={accessToken} />,
  typedMemory:   ({ accessToken }) => <TypedMemoryPanel  accessToken={accessToken} />,
  sessions:      ({ accessToken }) => <SessionsPanel     accessToken={accessToken} />,
  mcpOAuth:      ({ accessToken }) => <McpOAuthWizard    accessToken={accessToken} />,
  keybindings:   ({ accessToken }) => <KeybindingsPanel  accessToken={accessToken} />,
  logsStream:    ({ accessToken }) => <LogsStream        accessToken={accessToken} />,
  compaction:    ({ accessToken }) => <CompactionSettingsPanel accessToken={accessToken} />,
  modelTiers:    ({ accessToken }) => <ModelTiersPanel   accessToken={accessToken} />,
  toolsFilter:   ({ accessToken }) => <ToolsFilterPanel  accessToken={accessToken} />,
  lsp:           ({ accessToken }) => <LSPStatusPanel    accessToken={accessToken} />,
  orchestration: ({ accessToken }) => <OrchestrationPanel accessToken={accessToken} />,
};

export default function ConfigSection({ onBack, initialTab = 'agents' }) {
  const storeTab   = useUIStore((s) => s.configTab);
  const storeNonce = useUIStore((s) => s.configTabNonce);
  const [tab, setTab] = useState(storeTab || initialTab);
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Sync con el store: si otro componente llama setSection('config', { configTab: 'mcps' })
  // el tab cambia al que pidieron. El nonce fuerza re-evaluación incluso si el valor repite.
  useEffect(() => {
    if (storeTab) setTab(storeTab);
  }, [storeTab, storeNonce]);

  const activeExtraTabs = useMemo(
    () => EXTRA_CONFIG_TABS.filter(t => isFeature(t.flag) && (!t.requiresAdmin || isAdmin)),
    [isAdmin]
  );
  const tabs = useMemo(() => [...CONFIG_TABS, ...activeExtraTabs], [activeExtraTabs]);

  const accessToken = useMemo(() => getStoredTokens()?.accessToken, [user]);
  const extraFactory = EXTRA_PANELS[tab];

  return (
    <div className={styles.configBody}>
      <div className={styles.configTabBar}>
        {onBack && (
          <button className={styles.configBackBtn} onClick={onBack} aria-label="Volver">
            <ChevronLeft size={18} />
          </button>
        )}
        {tabs.map(({ key, Icon, label, group }) => (
          <button
            key={key}
            className={`${styles.configTab} ${tab === key ? styles.active : ''}`}
            onClick={() => setTab(key)}
            data-group={group || 'core'}
            title={group ? `${label} · ${group}` : label}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div className={styles.configTabBody}>
        <ErrorBoundary>
          <Suspense fallback={<Skeleton lines={4} style={{ padding: '24px' }} />}>
            {tab === 'agents'    && <AgentsPanel    onClose={null} embedded />}
            {tab === 'providers' && <ProvidersPanel onClose={null} embedded />}
            {tab === 'mcps'      && <McpsPanel      onClose={null} embedded />}
            {tab === 'limits'    && <LimitsPanel    onClose={null} embedded />}
            {tab === 'voice'       && <VoicePanel       onClose={null} embedded />}
            {tab === 'transcriber' && <TranscriberPanel onClose={null} embedded />}
            {tab === 'nodriza'     && <NodrizaPanel     onClose={null} embedded />}
            {tab === 'reminders'   && <RemindersPanel   onClose={null} embedded />}
            {tab === 'memory'      && <MemoryPanel      onClose={null} embedded />}
            {tab === 'logs'        && <LogsPanel        onClose={null} embedded />}
            {tab === 'profile'     && <ProfilePanel     onClose={null} embedded />}
            {extraFactory && extraFactory({ accessToken, userId: user?.id, isAdmin })}
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
