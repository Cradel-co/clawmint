import { EyeOff, Users } from 'lucide-react';
import styles from '../WebChatPanel.module.css';

export default function StatusBar({ connected, providerLabel, agent, cwd, statusText, mode }) {
  return (
    <div className={styles.statusBar}>
      <span className={`${styles.dot} ${connected ? styles.on : styles.off}`} />
      <span>{providerLabel}</span>
      {agent && <span> &middot; {agent}</span>}
      <span className={styles.cwd}> &middot; {cwd}</span>
      {mode === 'incognito' && (
        <span className={styles.modeBadge} title="Modo privado: este chat no se guarda">
          <EyeOff size={11} /> Privado
        </span>
      )}
      {mode === 'household' && (
        <span className={`${styles.modeBadge} ${styles.modeBadgeHousehold}`} title="Compartido con el hogar">
          <Users size={11} /> Hogar
        </span>
      )}
      {statusText && <span className={styles.statusText}> &middot; {statusText}</span>}
    </div>
  );
}
