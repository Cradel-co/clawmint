import { useState, useEffect, useRef, useCallback } from 'react';
import { Trash2, Paperclip, Volume2, Send, Mic, Square, X, Pause, Play } from 'lucide-react';
import { API_BASE, WS_URL } from '../config.js';
import ChatMessage from './ChatMessage.jsx';
import './WebChatPanel.css';

export default function WebChatPanel({ onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [provider, setProvider] = useState('anthropic');
  const [agent, setAgent] = useState(null);
  const [providers, setProviders] = useState([]);
  const [agentsList, setAgentsList] = useState([]);
  const [cwd, setCwd] = useState('~');
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recPaused, setRecPaused] = useState(false);
  const [recTime, setRecTime] = useState(0);
  const [statusText, setStatusText] = useState(null);
  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordStartRef = useRef(0);
  const recTimerRef = useRef(null);
  const recCancelledRef = useRef(false);
  const recTimeRef = useRef(0);
  const streamRef = useRef(null);
  const fileInputRef = useRef(null);

  // Scroll automático al final
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Cargar providers y agentes
  useEffect(() => {
    fetch(`${API_BASE}/api/providers`)
      .then(r => r.json())
      .then(data => {
        setProviders(data.providers || []);
        if (data.default) setProvider(data.default);
      })
      .catch(() => {});
    fetch(`${API_BASE}/api/agents`)
      .then(r => r.json())
      .then(data => setAgentsList(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  // Conectar WebSocket
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      const savedSessionId = localStorage.getItem('wc-session-id');
      const authToken = localStorage.getItem('wc-auth-token') || undefined;
      ws.send(JSON.stringify({
        type: 'init',
        sessionType: 'webchat',
        ...(savedSessionId ? { sessionId: savedSessionId } : {}),
        ...(authToken ? { authToken } : {}),
      }));
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'session_id':
            sessionIdRef.current = msg.id;
            localStorage.setItem('wc-session-id', msg.id);
            break;

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
            break;

          case 'chat_error':
            setMessages(prev => [
              ...prev,
              { role: 'system', content: `Error: ${msg.error}`, error: true },
            ]);
            setSending(false);
            setStatusText(null);
            break;

          case 'command_result':
            setMessages(prev => [
              ...prev,
              { role: 'system', content: msg.text },
            ]);
            if (msg.provider) setProvider(msg.provider);
            if (msg.agent !== undefined) setAgent(msg.agent);
            if (msg.cwd) setCwd(msg.cwd);
            setSending(false);
            break;

          case 'history_restore':
            if (Array.isArray(msg.messages) && msg.messages.length > 0) {
              setMessages(msg.messages.map(m => ({
                role: m.role,
                content: m.content,
                streaming: false,
              })));
            }
            break;

          case 'auth_error':
            setMessages([{ role: 'system', content: msg.error || 'Error de autenticación', error: true }]);
            setConnected(false);
            break;

          case 'chat:transcription':
            // Agregar transcripción al último mensaje de audio del usuario
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

          case 'chat:status':
            if (msg.status === 'transcribing') setStatusText('Transcribiendo...');
            else if (msg.status === 'synthesizing') setStatusText('Generando audio...');
            else setStatusText(null);
            break;

          case 'chat:tts_audio': {
            // Mostrar audio TTS como mensaje con reproductor
            const audioUrl = `data:${msg.mimeType || 'audio/wav'};base64,${msg.data}`;
            setMessages(prev => [...prev, { role: 'tts', audioUrl }]);
            setStatusText(null);
            break;
          }

          case 'chat:tts_error':
            setStatusText(null);
            setMessages(prev => [
              ...prev,
              { role: 'system', content: `TTS: ${msg.error || 'No disponible'}`, error: true },
            ]);
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
              mediaSrc: href, caption: msg.caption, filename: msg.filename,
              mimeType: msg.mimeType,
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
              mediaSrc: videoUrl, caption: msg.caption, filename: msg.filename,
              mimeType: msg.mimeType,
            }]);
            setSending(false);
            setStatusText(null);
            break;
          }

          case 'chat:delete':
            setMessages(prev => prev.filter(m => m.msgId !== msg.msgId));
            break;

          case 'chat:edit':
            setMessages(prev => prev.map(m =>
              m.msgId === msg.msgId ? { ...m, content: msg.text } : m
            ));
            break;

          case 'status':
            if (msg.provider) setProvider(msg.provider);
            if (msg.agent !== undefined) setAgent(msg.agent);
            if (msg.cwd) setCwd(msg.cwd);
            break;
        }
      } catch { /* ignorar */ }
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = () => {};

    return () => ws.close();
  }, []);

  // ── Enviar mensaje ─────────────────────────────────────────────────────────

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setSending(true);

    ws.send(JSON.stringify({ type: 'chat', text, provider, agent }));
  }, [input, sending, provider, agent]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat', text: '/nueva', provider, agent }));
    }
  };

  // ── Botones inline ─────────────────────────────────────────────────────────

  const handleButtonClick = useCallback((btn) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const data = btn.callback_data || btn.data || btn.text || btn.label;
    ws.send(JSON.stringify({ type: 'chat:action', data }));
    setSending(true);
  }, []);

  // ── Audio (grabación) ──────────────────────────────────────────────────────

  // Formatear segundos a m:ss
  const formatRecTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, '0');
    return `${m}:${sec}`;
  };

  // Timer de grabación
  useEffect(() => {
    if (recording && !recPaused) {
      recTimerRef.current = setInterval(() => setRecTime(t => { recTimeRef.current = t + 1; return t + 1; }), 1000);
    } else {
      clearInterval(recTimerRef.current);
    }
    return () => clearInterval(recTimerRef.current);
  }, [recording, recPaused]);

  // Limpiar estado de grabación
  const cleanupRecording = useCallback(() => {
    clearInterval(recTimerRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    setRecording(false);
    setRecPaused(false);
    setRecTime(0);
  }, []);

  // Iniciar grabación
  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      const hint = !window.isSecureContext
        ? 'Necesitás acceder via HTTPS o localhost para usar el micrófono'
        : 'Tu navegador no soporta grabación de audio';
      setStatusText(hint);
      setTimeout(() => setStatusText(null), 5000);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      recCancelledRef.current = false;
      recTimeRef.current = 0;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        if (recCancelledRef.current) return; // Descartado
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const actualMime = mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: actualMime });
        const audioUrl = URL.createObjectURL(blob);
        const audioDuration = recTimeRef.current;
        setMessages(prev => [...prev, { role: 'user', audioUrl, audioDuration, transcription: null }]);
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          setSending(true);
          ws.send(JSON.stringify({ type: 'chat:audio', data: base64, mimeType: actualMime }));
        };
        reader.readAsDataURL(blob);
      };

      mediaRecorder.start();
      recordStartRef.current = Date.now();
      setRecording(true);
      setRecPaused(false);
      setRecTime(0);
    } catch (err) {
      let errorMsg = 'Micrófono no disponible';
      if (err.name === 'NotAllowedError') errorMsg = 'Permiso de micrófono denegado. Revisá los permisos del navegador';
      else if (err.name === 'NotFoundError') errorMsg = 'No se encontró ningún micrófono';
      else if (err.name === 'NotReadableError') errorMsg = 'El micrófono está siendo usado por otra aplicación';
      setStatusText(errorMsg);
      setTimeout(() => setStatusText(null), 5000);
    }
  }, []);

  // Cancelar grabación (descartar)
  const cancelRecording = useCallback(() => {
    recCancelledRef.current = true;
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
    cleanupRecording();
  }, [cleanupRecording]);

  // Pausar / reanudar grabación
  const togglePauseRecording = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    if (mr.state === 'recording') {
      mr.pause();
      setRecPaused(true);
    } else if (mr.state === 'paused') {
      mr.resume();
      setRecPaused(false);
    }
  }, []);

  // Enviar grabación
  const sendRecording = useCallback(() => {
    recCancelledRef.current = false;
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
    setRecording(false);
    setRecPaused(false);
    setRecTime(0);
  }, []);

  // ── TTS (reproducir última respuesta) ──────────────────────────────────────

  const playTTS = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Buscar última respuesta del asistente
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) return;
    ws.send(JSON.stringify({ type: 'chat:tts', text: lastAssistant.content }));
    setStatusText('Generando audio...');
  }, [messages]);

  // ── File upload ────────────────────────────────────────────────────────────

  const handleFileSelect = useCallback((e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const file = files[0];
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      const mediaType = file.type || 'application/octet-stream';

      if (isImage) {
        const text = input.trim() || 'Describe esta imagen';
        setMessages(prev => [...prev, {
          role: 'user',
          content: `[Imagen: ${file.name}] ${text}`,
        }]);
        setInput('');
        setSending(true);
        ws.send(JSON.stringify({
          type: 'chat',
          text,
          provider,
          agent,
          images: [{ base64, mediaType }],
        }));
      } else {
        const text = input.trim() || 'Analiza este archivo';
        setMessages(prev => [...prev, {
          role: 'user',
          content: `[Archivo: ${file.name}] ${text}`,
        }]);
        setInput('');
        setSending(true);
        ws.send(JSON.stringify({
          type: 'chat',
          text,
          provider,
          agent,
          files: [{ base64, mediaType, name: file.name }],
        }));
      }
    };
    reader.readAsDataURL(file);
    // Reset input para permitir seleccionar el mismo archivo
    e.target.value = '';
  }, [input, provider, agent]);

  // ── Drag & drop ────────────────────────────────────────────────────────────

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const file = files[0];
    const isImage = file.type.startsWith('image/');

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      const mediaType = file.type || 'application/octet-stream';

      if (isImage) {
        const text = input.trim() || 'Describe esta imagen';
        setMessages(prev => [...prev, {
          role: 'user',
          content: `[Imagen: ${file.name}] ${text}`,
        }]);
        setInput('');
        setSending(true);
        ws.send(JSON.stringify({
          type: 'chat',
          text,
          provider,
          agent,
          images: [{ base64, mediaType }],
        }));
      } else {
        const text = input.trim() || 'Analiza este archivo';
        setMessages(prev => [...prev, {
          role: 'user',
          content: `[Archivo: ${file.name}] ${text}`,
        }]);
        setInput('');
        setSending(true);
        ws.send(JSON.stringify({
          type: 'chat',
          text,
          provider,
          agent,
          files: [{ base64, mediaType, name: file.name }],
        }));
      }
    };
    reader.readAsDataURL(file);
  }, [input, provider, agent]);

  const handleDragOver = (e) => e.preventDefault();

  const providerLabel = providers.find(p => p.name === provider)?.label || provider;

  return (
    <div className="wc-panel" onDrop={handleDrop} onDragOver={handleDragOver}>
      <div className="wc-header">
        <span className="wc-header-title">Chat</span>
        <div className="wc-header-controls">
          <select
            className="wc-select"
            value={provider}
            onChange={e => setProvider(e.target.value)}
          >
            {providers.filter(p => p.configured).map(p => (
              <option key={p.name} value={p.name}>{p.label || p.name}</option>
            ))}
          </select>
          <select
            className="wc-select"
            value={agent || ''}
            onChange={e => setAgent(e.target.value || null)}
          >
            <option value="">Sin agente</option>
            {agentsList.map(a => (
              <option key={a.key} value={a.key}>{a.key}</option>
            ))}
          </select>
          <button className="wc-btn-icon" onClick={clearChat} title="Nueva conversación"><Trash2 size={14} /></button>
          <button className="wc-close" onClick={onClose}><X size={16} /></button>
        </div>
      </div>

      <div className="wc-status-bar">
        <span className={`wc-dot ${connected ? 'on' : 'off'}`} />
        <span>{providerLabel}</span>
        {agent && <span> &middot; {agent}</span>}
        <span className="wc-cwd"> &middot; {cwd}</span>
        {statusText && <span className="wc-status-text"> &middot; {statusText}</span>}
      </div>

      <div className="wc-messages">
        {messages.length === 0 && (
          <div className="wc-empty">
            <p>Escribí algo para comenzar</p>
            <p className="wc-hint">
              Usá / para comandos: /ayuda
            </p>
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
            onButtonClick={handleButtonClick}
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

      <div className="wc-input-area">
        {recording ? (
          /* ── Barra de grabación ── */
          <div className="wc-rec-bar">
            <button className="wc-rec-btn wc-rec-cancel" onClick={cancelRecording} title="Cancelar grabación">
              <Trash2 size={16} />
            </button>
            <div className="wc-rec-indicator">
              <span className={`wc-rec-dot ${recPaused ? 'wc-rec-dot-paused' : ''}`} />
              <span className="wc-rec-time">{formatRecTime(recTime)}</span>
            </div>
            <button className="wc-rec-btn wc-rec-pause" onClick={togglePauseRecording} title={recPaused ? 'Reanudar' : 'Pausar'}>
              {recPaused ? <Mic size={16} /> : <Pause size={16} />}
            </button>
            <button className="wc-rec-btn wc-rec-send" onClick={sendRecording} title="Enviar audio">
              <Send size={16} />
            </button>
          </div>
        ) : (
          /* ── Barra normal de input ── */
          <>
            <input
              type="file"
              ref={fileInputRef}
              className="wc-file-input"
              accept="image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx,.csv,.json,.xml,.zip,.rar,.7z,.mp3,.wav,.ogg,.mp4,.webm"
              onChange={handleFileSelect}
            />
            <button
              className="wc-btn-icon wc-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected || sending}
              title="Adjuntar archivo"
            >
              <Paperclip size={16} />
            </button>
            <textarea
              ref={inputRef}
              className="wc-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribí un mensaje..."
              rows={1}
              disabled={!connected}
            />
            <button
              className="wc-btn-icon wc-tts-btn"
              onClick={playTTS}
              disabled={!connected || !messages.some(m => m.role === 'assistant')}
              title="Escuchar última respuesta (TTS)"
            >
              <Volume2 size={16} />
            </button>
            {input.trim() ? (
              <button
                className="wc-send"
                onClick={sendMessage}
                disabled={sending || !connected}
              >
                {sending ? '...' : <Send size={16} />}
              </button>
            ) : (
              <button
                className="wc-send wc-send-mic"
                onClick={startRecording}
                disabled={!connected || sending}
                title="Grabar audio"
              >
                <Mic size={16} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
