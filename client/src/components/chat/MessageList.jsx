import { useRef, useEffect } from 'react';
import ChatMessage from '../ChatMessage.jsx';

export default function MessageList({ messages, sending, connected, providerLabel, onButtonClick }) {
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="wc-messages">
      {messages.length === 0 && (
        <div className="wc-empty">
          {connected ? (
            <>
              <p>Escribí algo para comenzar</p>
              <p className="wc-hint">Usá / para comandos: /ayuda</p>
            </>
          ) : (
            <>
              <p>Sin conexión al servidor</p>
              <p className="wc-hint">Verificá que el servidor esté corriendo y recargá la página</p>
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
        <div className="wc-msg wc-msg-assistant">
          <div className="wc-msg-label">{providerLabel}</div>
          <div className="wc-msg-content wc-typing-indicator">
            <span className="wc-typing-dot" />
            <span className="wc-typing-dot" />
            <span className="wc-typing-dot" />
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}
