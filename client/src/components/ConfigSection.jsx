import { useState, lazy, Suspense } from 'react';
import { ChevronLeft } from 'lucide-react';
import ErrorBoundary from './ErrorBoundary.jsx';
import Skeleton from './Skeleton.jsx';
import { CONFIG_TABS } from './layout/sectionMeta';
import styles from '../App.module.css';

const AgentsPanel    = lazy(() => import('./AgentsPanel.jsx'));
const ProvidersPanel = lazy(() => import('./ProvidersPanel.jsx'));
const McpsPanel      = lazy(() => import('./McpsPanel.jsx'));
const LimitsPanel    = lazy(() => import('./LimitsPanel.jsx'));
const VoicePanel       = lazy(() => import('./VoicePanel.jsx'));
const TranscriberPanel = lazy(() => import('./TranscriberPanel.jsx'));
const NodrizaPanel     = lazy(() => import('./NodrizaPanel.jsx'));
const RemindersPanel   = lazy(() => import('./RemindersPanel.jsx'));
const MemoryPanel      = lazy(() => import('./MemoryPanel.jsx'));
const LogsPanel        = lazy(() => import('./LogsPanel.jsx'));
const ProfilePanel     = lazy(() => import('./ProfilePanel.jsx'));

export default function ConfigSection({ onBack }) {
  const [tab, setTab] = useState('agents');
  return (
    <div className={styles.configBody}>
      <div className={styles.configTabBar}>
        {onBack && (
          <button className={styles.configBackBtn} onClick={onBack} aria-label="Volver">
            <ChevronLeft size={18} />
          </button>
        )}
        {CONFIG_TABS.map(({ key, Icon, label }) => (
          <button
            key={key}
            className={`${styles.configTab} ${tab === key ? styles.active : ''}`}
            onClick={() => setTab(key)}
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
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
