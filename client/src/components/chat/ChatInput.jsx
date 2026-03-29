import { useRef, useCallback } from 'react';
import { Paperclip, Volume2, Send, Mic } from 'lucide-react';
import RecordingBar from './RecordingBar.jsx';
import styles from '../WebChatPanel.module.css';

export default function ChatInput({
  input, setInput, connected, sending,
  onSend, onPlayTTS, hasTTSContent,
  // Audio recorder
  recording, recPaused, recTime,
  onStartRecording, onCancelRecording, onTogglePause, onSendRecording,
  // File upload
  fileInputRef, onOpenFilePicker, onFileSelect,
}) {
  const inputRef = useRef(null);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }, [onSend]);

  if (recording) {
    return (
      <div className={styles.inputArea}>
        <RecordingBar
          recTime={recTime}
          recPaused={recPaused}
          onCancel={onCancelRecording}
          onTogglePause={onTogglePause}
          onSend={onSendRecording}
        />
      </div>
    );
  }

  return (
    <div className={styles.inputArea}>
      <input
        type="file"
        ref={fileInputRef}
        className={styles.fileInput}
        accept="image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx,.csv,.json,.xml,.zip,.rar,.7z,.mp3,.wav,.ogg,.mp4,.webm"
        onChange={(e) => onFileSelect(e, input.trim())}
      />
      <button
        className={`${styles.btnIcon} ${styles.attachBtn}`}
        onClick={onOpenFilePicker}
        disabled={!connected || sending}
        title="Adjuntar archivo"
      >
        <Paperclip size={16} />
      </button>
      <textarea
        ref={inputRef}
        className={styles.input}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Escribí un mensaje..."
        rows={1}
        disabled={!connected}
      />
      <button
        className={`${styles.btnIcon} ${styles.ttsBtn}`}
        onClick={onPlayTTS}
        disabled={!connected || !hasTTSContent}
        title="Escuchar última respuesta (TTS)"
      >
        <Volume2 size={16} />
      </button>
      {input.trim() ? (
        <button
          className={styles.send}
          onClick={onSend}
          disabled={sending || !connected}
        >
          {sending ? '...' : <Send size={16} />}
        </button>
      ) : (
        <button
          className={`${styles.send} ${styles.sendMic}`}
          onClick={onStartRecording}
          disabled={!connected || sending}
          title="Grabar audio"
        >
          <Mic size={16} />
        </button>
      )}
    </div>
  );
}
