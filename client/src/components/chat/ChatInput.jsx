import { useRef, useCallback, useState } from 'react';
import { Paperclip, Volume2, Mic, ArrowUp, Plus } from 'lucide-react';
import RecordingBar from './RecordingBar.jsx';
import InputToolMenu from './InputToolMenu.jsx';
import styles from '../WebChatPanel.module.css';

export default function ChatInput({
  input, setInput, connected, sending,
  onSend, onPlayTTS, hasTTSContent,
  // Audio recorder
  recording, recPaused, recTime,
  onStartRecording, onCancelRecording, onTogglePause, onSendRecording,
  // File upload
  fileInputRef, onOpenFilePicker, onFileSelect,
  // Tool menu
  claudeMode, onModeChange,
  webSearch, onWebSearchToggle,
  providers, provider, onProviderChange,
  agentsList, agent, onAgentChange,
  cwd, skills,
  onWebcam, onScreenshotRemote, onPasteClipboard,
  onCdChange, onNew, onShowCost, onInvokeSkill,
}) {
  const inputRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }, [onSend]);

  if (recording) {
    return (
      <div className={styles.inputArea}>
        <div className={styles.inputBox}>
          <RecordingBar
            recTime={recTime}
            recPaused={recPaused}
            onCancel={onCancelRecording}
            onTogglePause={onTogglePause}
            onSend={onSendRecording}
          />
        </div>
      </div>
    );
  }

  const hasText = input.trim().length > 0;
  const handlePrefill = (text) => {
    setInput((input ? input.trim() + ' ' : '') + text);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className={styles.inputArea}>
      <input
        type="file"
        ref={fileInputRef}
        className={styles.fileInput}
        accept="image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx,.csv,.json,.xml,.zip,.rar,.7z,.mp3,.wav,.ogg,.mp4,.webm"
        onChange={(e) => onFileSelect(e, input.trim())}
      />
      <div className={styles.inputBoxWrap}>
        <InputToolMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          claudeMode={claudeMode}
          onModeChange={onModeChange}
          webSearch={webSearch}
          onWebSearchToggle={onWebSearchToggle}
          providers={providers}
          provider={provider}
          onProviderChange={onProviderChange}
          agentsList={agentsList}
          agent={agent}
          onAgentChange={onAgentChange}
          cwd={cwd}
          skills={skills}
          onAttachFile={onOpenFilePicker}
          onWebcam={onWebcam}
          onScreenshotRemote={onScreenshotRemote}
          onPasteClipboard={onPasteClipboard}
          onPrefill={handlePrefill}
          onCdChange={onCdChange}
          onNew={onNew}
          onShowCost={onShowCost}
          onInvokeSkill={onInvokeSkill}
        />
        <div className={styles.inputBox}>
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
          <div className={styles.inputFooter}>
            <div className={styles.inputActions}>
              <button
                className={`${styles.toolBtn} ${menuOpen ? styles.toolBtnActive : ''}`}
                onClick={() => setMenuOpen(v => !v)}
                disabled={!connected}
                title="Más herramientas"
              >
                <Plus size={18} />
              </button>
              <button
                className={styles.toolBtn}
                onClick={onOpenFilePicker}
                disabled={!connected || sending}
                title="Adjuntar archivo"
              >
                <Paperclip size={18} />
              </button>
              <button
                className={styles.toolBtn}
                onClick={onPlayTTS}
                disabled={!connected || !hasTTSContent}
                title="Escuchar última respuesta (TTS)"
              >
                <Volume2 size={18} />
              </button>
              {webSearch && (
                <span className={styles.modeBadge} title="Buscar en la web activado para el próximo mensaje">🌐 Web</span>
              )}
              {claudeMode && claudeMode !== 'auto' && (
                <span className={styles.modeBadge} title={`Modo: ${claudeMode}`}>⚙️ {claudeMode}</span>
              )}
            </div>
            <button
              className={styles.send}
              onClick={hasText ? onSend : onStartRecording}
              disabled={hasText ? (sending || !connected) : (!connected || sending)}
              title={hasText ? 'Enviar' : 'Grabar audio'}
            >
              {sending ? '…' : hasText ? <ArrowUp size={16} /> : <Mic size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
