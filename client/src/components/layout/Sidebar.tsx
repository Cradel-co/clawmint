import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { SECTION_META, NAV_TOP, NAV_MID } from './sectionMeta';
import styles from '../../App.module.css';

const ITEM_CLASS: Record<string, string> = {
  terminal: styles.sidebarItemTerminal,
  chat: styles.sidebarItemChat,
  telegram: styles.sidebarItemTelegram,
  contacts: styles.sidebarItemContacts,
  config: styles.sidebarItemConfig,
};

export default function Sidebar() {
  const { section, setSection, chatBadge, telegramBadge, sidebarExpanded, toggleSidebar } = useUIStore();

  const renderItem = (key: string) => {
    const { Icon, label } = SECTION_META[key];
    const badge = key === 'telegram' ? telegramBadge : key === 'chat' ? chatBadge : 0;
    return (
      <button
        key={key}
        className={`${styles.sidebarItem} ${ITEM_CLASS[key] || ''} ${section === key ? styles.active : ''}`}
        onClick={() => setSection(key as any)}
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
        {NAV_TOP.map(renderItem)}
        <div className={styles.sidebarDivider} aria-hidden="true" />
        {NAV_MID.map(renderItem)}
      </nav>

      <div className={styles.sidebarBottom}>
        <div className={styles.sidebarDivider} aria-hidden="true" />
        {renderItem('config')}
        <button
          className={`${styles.sidebarItem} ${styles.sidebarToggleBtn}`}
          onClick={toggleSidebar}
          title={sidebarExpanded ? 'Colapsar sidebar' : 'Expandir sidebar'}
          aria-label={sidebarExpanded ? 'Colapsar sidebar' : 'Expandir sidebar'}
        >
          {sidebarExpanded
            ? <ChevronLeft  size={16} aria-hidden="true" />
            : <ChevronRight size={16} aria-hidden="true" />}
        </button>
      </div>
    </aside>
  );
}
