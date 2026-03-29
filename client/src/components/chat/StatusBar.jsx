import styles from '../WebChatPanel.module.css';

export default function StatusBar({ connected, providerLabel, agent, cwd, statusText }) {
  return (
    <div className={styles.statusBar}>
      <span className={`${styles.dot} ${connected ? styles.on : styles.off}`} />
      <span>{providerLabel}</span>
      {agent && <span> &middot; {agent}</span>}
      <span className={styles.cwd}> &middot; {cwd}</span>
      {statusText && <span className={styles.statusText}> &middot; {statusText}</span>}
    </div>
  );
}
