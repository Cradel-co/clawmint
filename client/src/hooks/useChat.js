import { useState, useCallback } from 'react';

/**
 * Hook que maneja el estado del chat y procesamiento de mensajes WS.
 * Extrae la lógica de mensajes de WebChatPanel para testabilidad.
 */
export default function useChat({ onAuthMessage, onNewMessage }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [provider, setProvider] = useState('anthropic');
  const [agent, setAgent] = useState(null);
  const [cwd, setCwd] = useState('~');
  const [statusText, setStatusText] = useState(null);

  const handleWsMessage = useCallback((msg) => {
    // Delegar mensajes de auth al contexto
    if (['session_id', 'auth:tokens', 'auth_error', 'session_taken'].includes(msg.type)) {
      onAuthMessage?.(msg);
    }

    switch (msg.type) {
      case 'chat_chunk':
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, content: msg.text }];
          }
          return [...prev, { role: 'assistant', content: msg.text, streaming: true }];
        });
        break;

      case 'chat:message':
      case 'chat_done':
        setMessages(prev => {
          const last = prev[prev.length - 1];
          const entry = { content: msg.text, streaming: false, ...(msg.buttons ? { buttons: msg.buttons } : {}) };
          if (last && last.role === 'assistant' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, ...entry }];
          }
          return [...prev, { role: 'assistant', ...entry }];
        });
        setSending(false);
        setStatusText(null);
        onNewMessage?.();
        break;

      case 'chat_error':
        setMessages(prev => [...prev, { role: 'system', content: `Error: ${msg.error}`, error: true }]);
        setSending(false);
        setStatusText(null);
        break;

      case 'command_result':
        setMessages(prev => [...prev, { role: 'system', content: msg.text }]);
        if (msg.provider) setProvider(msg.provider);
        if (msg.agent !== undefined) setAgent(msg.agent);
        if (msg.cwd) setCwd(msg.cwd);
        setSending(false);
        break;

      case 'history_restore':
        if (Array.isArray(msg.messages) && msg.messages.length > 0) {
          setMessages(msg.messages.map(m => ({ role: m.role, content: m.content, streaming: false })));
        }
        break;

      case 'auth_error':
        setMessages([{ role: 'system', content: msg.error || 'Error de autenticación', error: true }]);
        break;

      case 'chat:transcription':
        setMessages(prev => {
          const idx = prev.findLastIndex(m => m.role === 'user' && m.audioUrl);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], transcription: msg.text };
            return updated;
          }
          return [...prev, { role: 'user', content: msg.text }];
        });
        break;

      case 'chat_status':
        if (msg.status === 'thinking') setStatusText(msg.detail ? `🤔 ${msg.detail}...` : '🤔 Pensando...');
        else if (msg.status === 'tool_use') setStatusText(`⚡ ${msg.detail || 'Ejecutando tool'}...`);
        else setStatusText(null);
        break;

      case 'chat_ask_permission':
        setMessages(prev => [...prev, {
          role: 'system',
          content: `🔐 Permiso requerido — herramienta: ${msg.tool}\n${msg.args}`,
          askPermission: true,
          buttons: [
            { text: '✅ Aprobar', callback_data: msg.approveId },
            { text: '❌ Rechazar', callback_data: msg.rejectId },
          ],
        }]);
        break;

      case 'chat:status':
        if (msg.status === 'transcribing') setStatusText('Transcribiendo...');
        else if (msg.status === 'synthesizing') setStatusText('Generando audio...');
        else setStatusText(null);
        break;

      case 'chat:tts_audio': {
        const audioUrl = `data:${msg.mimeType || 'audio/wav'};base64,${msg.data}`;
        setMessages(prev => [...prev, { role: 'tts', audioUrl }]);
        setStatusText(null);
        break;
      }

      case 'chat:tts_error':
        setStatusText(null);
        setMessages(prev => [...prev, { role: 'system', content: `TTS: ${msg.error || 'No disponible'}`, error: true }]);
        break;

      case 'chat:photo': {
        const src = `data:${msg.mimeType || 'image/png'};base64,${msg.data}`;
        setMessages(prev => [...prev, {
          role: 'assistant', msgId: msg.msgId, mediaType: 'photo',
          mediaSrc: src, caption: msg.caption, filename: msg.filename,
        }]);
        setSending(false);
        setStatusText(null);
        break;
      }

      case 'chat:document': {
        const href = `data:${msg.mimeType || 'application/octet-stream'};base64,${msg.data}`;
        setMessages(prev => [...prev, {
          role: 'assistant', msgId: msg.msgId, mediaType: 'document',
          mediaSrc: href, caption: msg.caption, filename: msg.filename, mimeType: msg.mimeType,
        }]);
        setSending(false);
        setStatusText(null);
        break;
      }

      case 'chat:voice': {
        const voiceUrl = `data:${msg.mimeType || 'audio/ogg'};base64,${msg.data}`;
        setMessages(prev => [...prev, {
          role: 'assistant', msgId: msg.msgId, mediaType: 'voice',
          mediaSrc: voiceUrl, caption: msg.caption,
        }]);
        setSending(false);
        setStatusText(null);
        break;
      }

      case 'chat:video': {
        const videoUrl = `data:${msg.mimeType || 'video/mp4'};base64,${msg.data}`;
        setMessages(prev => [...prev, {
          role: 'assistant', msgId: msg.msgId, mediaType: 'video',
          mediaSrc: videoUrl, caption: msg.caption, filename: msg.filename, mimeType: msg.mimeType,
        }]);
        setSending(false);
        setStatusText(null);
        break;
      }

      case 'chat:delete':
        setMessages(prev => prev.filter(m => m.msgId !== msg.msgId));
        break;

      case 'chat:edit':
        setMessages(prev => prev.map(m => m.msgId === msg.msgId ? { ...m, content: msg.text } : m));
        break;

      case 'session_taken':
        setMessages(prev => [...prev, {
          role: 'system', content: msg.message || 'Sesión abierta desde otro dispositivo', error: true,
        }]);
        break;

      case 'status':
        if (msg.provider) setProvider(msg.provider);
        if (msg.agent !== undefined) setAgent(msg.agent);
        if (msg.cwd) setCwd(msg.cwd);
        break;
    }
  }, [onAuthMessage, onNewMessage]);

  const addUserMessage = useCallback((content, extra = {}) => {
    setMessages(prev => [...prev, { role: 'user', content, ...extra }]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const setError = useCallback((text, timeout = 5000) => {
    setStatusText(text);
    if (timeout) setTimeout(() => setStatusText(null), timeout);
  }, []);

  return {
    messages, setMessages,
    input, setInput,
    sending, setSending,
    provider, setProvider,
    agent, setAgent,
    cwd,
    statusText, setStatusText,
    handleWsMessage,
    addUserMessage,
    clearMessages,
    setError,
  };
}
