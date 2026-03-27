import { Trash2, Mic, Pause, Send } from 'lucide-react';

const formatRecTime = (s) => {
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
};

export default function RecordingBar({ recTime, recPaused, onCancel, onTogglePause, onSend }) {
  return (
    <div className="wc-rec-bar">
      <button className="wc-rec-btn wc-rec-cancel" onClick={onCancel} title="Cancelar grabación">
        <Trash2 size={16} />
      </button>
      <div className="wc-rec-indicator">
        <span className={`wc-rec-dot ${recPaused ? 'wc-rec-dot-paused' : ''}`} />
        <span className="wc-rec-time">{formatRecTime(recTime)}</span>
      </div>
      <button className="wc-rec-btn wc-rec-pause" onClick={onTogglePause} title={recPaused ? 'Reanudar' : 'Pausar'}>
        {recPaused ? <Mic size={16} /> : <Pause size={16} />}
      </button>
      <button className="wc-rec-btn wc-rec-send" onClick={onSend} title="Enviar audio">
        <Send size={16} />
      </button>
    </div>
  );
}
