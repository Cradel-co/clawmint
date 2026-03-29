import { useRef, useEffect } from 'react';
import ChatMessage from '../ChatMessage.jsx';
import styles from '../WebChatPanel.module.css';

export default function MessageList({ messages, sending, connected, providerLabel, onButtonClick }) {
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className={styles.messages}>
      {messages.length === 0 && (
        <div className={styles.empty}>
          {connected ? (
            <>
              <p>Escribí algo para comenzar</p>
              <p className={styles.hint}>Usá / para comandos: /ayuda</p>
            </>
          ) : (
            <>
              <p>Sin conexión al servidor</p>
              <p className={styles.hint}>Verificá que el servidor esté corriendo y recargá la página</p>
            </>
          )}
        </div>
      )}
      {messages.map((msg, i) => (
        <ChatMessage
          key={msg.msgId || i}
          content={msg.content}
          role={msg.role}
          streaming={msg.streaming}
          error={msg.error}
          providerLabel={providerLabel}
          buttons={msg.buttons}
          onButtonClick={onButtonClick}
          audioUrl={msg.audioUrl}
          audioDuration={msg.audioDuration}
          transcription={msg.transcription}
          mediaType={msg.mediaType}
          mediaSrc={msg.mediaSrc}
          caption={msg.caption}
          filename={msg.filename}
          mimeType={msg.mimeType}
        />
      ))}
      {sending && !messages.some(m => m.streaming) && (
        <div className={`${styles.msg} ${styles.msgAssistant}`}>
          <div className={styles.msgLabel}>{providerLabel}</div>
          <div className={`${styles.msgContent} ${styles.typingIndicator}`}>
            <span className={styles.typingDot} />
            <span className={styles.typingDot} />
            <span className={styles.typingDot} />
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}
