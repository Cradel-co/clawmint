import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { SECTION_META, NAV_GROUPS, SECTION_FLAGS } from './sectionMeta';
import { isFeature } from '../../hooks/useFeatureFlag';
import styles from '../../App.module.css';

const ITEM_CLASS = {
  dashboard:    styles.sidebarItemDashboard,
  terminal:     styles.sidebarItemTerminal,
  chat:         styles.sidebarItemChat,
  telegram:     styles.sidebarItemTelegram,
  contacts:     styles.sidebarItemContacts,
  household:    styles.sidebarItemHousehold,
  tasks:        styles.sidebarItemTasks,
  scheduler:    styles.sidebarItemScheduler,
  skills:       styles.sidebarItemSkills,
  integrations: styles.sidebarItemIntegrations,
  devices:      styles.sidebarItemDevices,
  music:        styles.sidebarItemMusic,
  config:       styles.sidebarItemConfig,
};

export default function Sidebar() {
  const { section, setSection, chatBadge, telegramBadge, sidebarExpanded, toggleSidebar } = useUIStore();

  const visibleGroups = useMemo(() => NAV_GROUPS
    .map(g => ({ ...g, keys: g.keys.filter(k => !SECTION_FLAGS[k] || isFeature(SECTION_FLAGS[k])) }))
    .filter(g => g.keys.length > 0), []);

  const renderItem = (key) => {
    const meta = SECTION_META[key];
    if (!meta) return null;
    const { Icon, label } = meta;
    const badge = key === 'telegram' ? telegramBadge : key === 'chat' ? chatBadge : 0;
    return (
      <button
        key={key}
        className={`${styles.sidebarItem} ${ITEM_CLASS[key] || ''} ${section === key ? styles.active : ''}`}
        onClick={() => setSection(key)}
        title={!sidebarExpanded ? label : undefined}
        aria-label={label}
        aria-current={section === key ? 'page' : undefined}
      >
        <Icon size={18} aria-hidden="true" />
        <span className={styles.sidebarLabel}>{label}</span>
        {badge > 0 && (
          <span className={styles.sidebarBadge} aria-label={`${badge} nuevos`}>{badge > 99 ? '99+' : badge}</span>
        )}
      </button>
    );
  };

  return (
    <aside className={`${styles.appSidebar}${sidebarExpanded ? ` ${styles.sidebarExpanded}` : ''}`} aria-label="Navegación principal">
      <nav className={styles.sidebarNav}>
        {visibleGroups.map((group, idx) => (
          <div key={group.label} className={styles.sidebarGroup}>
            {sidebarExpanded && <div className={styles.sidebarGroupLabel}>{group.label}</div>}
            {!sidebarExpanded && idx > 0 && <div className={styles.sidebarDivider} aria-hidden="true" />}
            {group.keys.map(renderItem)}
          </div>
        ))}
      </nav>

      <div className={styles.sidebarBottom}>
        <button
          className={`${styles.sidebarItem} ${styles.sidebarToggleBtn}`}
          onClick={toggleSidebar}
          title={sidebarExpanded ? 'Colapsar sidebar' : 'Expandir sidebar'}
          aria-label={sidebarExpanded ? 'Colapsar sidebar' : 'Expandir sidebar'}
        >
          {sidebarExpanded
            ? <ChevronLeft  size={16} aria-hidden="true" />
            : <ChevronRight size={16} aria-hidden="true" />}
          {sidebarExpanded && <span className={styles.sidebarLabel}>Colapsar</span>}
        </button>
      </div>
    </aside>
  );
}
