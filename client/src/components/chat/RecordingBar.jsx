import { Trash2, Mic, Pause, Send } from 'lucide-react';
import styles from '../WebChatPanel.module.css';

const formatRecTime = (s) => {
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
};

export default function RecordingBar({ recTime, recPaused, onCancel, onTogglePause, onSend }) {
  return (
    <div className={styles.recBar}>
      <button className={`${styles.recBtn} ${styles.recCancel}`} onClick={onCancel} title="Cancelar grabación">
        <Trash2 size={16} />
      </button>
      <div className={styles.recIndicator}>
        <span className={`${styles.recDot} ${recPaused ? styles.recDotPaused : ''}`} />
        <span className={styles.recTime}>{formatRecTime(recTime)}</span>
      </div>
      <button className={`${styles.recBtn} ${styles.recPause}`} onClick={onTogglePause} title={recPaused ? 'Reanudar' : 'Pausar'}>
        {recPaused ? <Mic size={16} /> : <Pause size={16} />}
      </button>
      <button className={`${styles.recBtn} ${styles.recSend}`} onClick={onSend} title="Enviar audio">
        <Send size={16} />
      </button>
    </div>
  );
}
