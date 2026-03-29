import { PanelsLeftRight } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import styles from '../../App.module.css';

export default function ContextBar() {
  const { splitMode, toggleSplit, splitChatState } = useUIStore();
  return (
    <div className={styles.contextBar}>
      {splitMode && splitChatState.cwd && (
        <span className={styles.contextCwd} title={splitChatState.cwd}>📁 {splitChatState.cwd}</span>
      )}
      {splitMode && splitChatState.provider && (
        <span className={styles.contextProvider}>⚡ {splitChatState.provider}</span>
      )}
      <span className={styles.contextSpacer} />
      <button
        className={`${styles.splitToggleBtn}${splitMode ? ` ${styles.splitToggleBtnActive}` : ''}`}
        onClick={toggleSplit}
        title={splitMode ? 'Cerrar split' : 'Abrir split con Chat IA'}
        aria-label={splitMode ? 'Cerrar modo split' : 'Abrir modo split'}
      >
        <PanelsLeftRight size={13} aria-hidden="true" />
        <span>{splitMode ? 'Cerrar split' : 'Split'}</span>
      </button>
    </div>
  );
}
