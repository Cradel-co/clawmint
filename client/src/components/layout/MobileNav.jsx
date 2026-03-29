import { Terminal, MessageCircle, Send, BookUser, Settings } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import styles from '../../App.module.css';

const NAV_ITEMS = [
  { key: 'terminal', Icon: Terminal,      label: 'Terminal' },
  { key: 'chat',     Icon: MessageCircle, label: 'Chat'     },
  { key: 'telegram', Icon: Send,          label: 'TG'       },
  { key: 'contacts', Icon: BookUser,      label: 'Contactos' },
];

export default function MobileNav() {
  const { section, setSection, chatBadge, telegramBadge } = useUIStore();

  return (
    <nav className={styles.mobileBottomNav} aria-label="Navegación móvil">
      {NAV_ITEMS.map(({ key, Icon, label }) => {
        const badge = key === 'chat' ? chatBadge : key === 'telegram' ? telegramBadge : 0;
        return (
          <button
            key={key}
            className={section === key ? styles.active : ''}
            onClick={() => setSection(key)}
            aria-label={label}
          >
            <span className={styles.mobileNavIcon}>
              <Icon size={20} aria-hidden="true" />
              {badge > 0 && <span className={styles.mobileNavBadge}>{badge > 99 ? '99+' : badge}</span>}
            </span>
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
