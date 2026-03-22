import { useState, useEffect, useRef, useCallback } from 'react';
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
  const [statusText, setStatusText] = useState(null);
  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
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

          case 'chat_done':
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'assistant' && last.streaming) {
                return [...prev.slice(0, -1), { ...last, content: msg.text, streaming: false }];
              }
              return [...prev, { role: 'assistant', content: msg.text, streaming: false }];
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
            // Mostrar texto transcrito como mensaje del usuario
            setMessages(prev => [...prev, { role: 'user', content: msg.text }]);
            break;

          case 'chat:status':
            if (msg.status === 'transcribing') setStatusText('Transcribiendo...');
            else if (msg.status === 'synthesizing') setStatusText('Generando audio...');
            else setStatusText(null);
            break;

          case 'chat:tts_audio': {
            // Reproducir audio TTS
            const audio = new Audio(`data:${msg.mimeType || 'audio/wav'};base64,${msg.data}`);
            audio.play().catch(() => {});
            setStatusText(null);
            break;
          }

          case 'chat:tts_error':
            setStatusText(null);
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

  const toggleRecording = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (recording) {
      // Parar grabación
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          setSending(true);
          ws.send(JSON.stringify({
            type: 'chat:audio',
            data: base64,
            mimeType: 'audio/webm',
          }));
        };
        reader.readAsDataURL(blob);
      };

      mediaRecorder.start();
      setRecording(true);
    } catch {
      setStatusText('Micrófono no disponible');
      setTimeout(() => setStatusText(null), 3000);
    }
  }, [recording]);

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
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      const mediaType = file.type || 'image/png';
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
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      const mediaType = file.type;
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
          <button className="wc-btn-icon" onClick={clearChat} title="Nueva conversación">&#128465;</button>
          <button className="wc-close" onClick={onClose}>&times;</button>
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
            key={i}
            content={msg.content}
            role={msg.role}
            streaming={msg.streaming}
            error={msg.error}
            providerLabel={providerLabel}
            buttons={msg.buttons}
            onButtonClick={handleButtonClick}
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
        <input
          type="file"
          ref={fileInputRef}
          className="wc-file-input"
          accept="image/*"
          onChange={handleFileSelect}
        />
        <button
          className="wc-btn-icon wc-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={!connected || sending}
          title="Adjuntar imagen"
        >
          &#128206;
        </button>
        <button
          className={`wc-btn-icon wc-mic-btn ${recording ? 'wc-recording' : ''}`}
          onClick={toggleRecording}
          disabled={!connected || (sending && !recording)}
          title={recording ? 'Parar grabación' : 'Grabar audio'}
        >
          &#127908;
        </button>
        <textarea
          ref={inputRef}
          className="wc-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={recording ? 'Grabando...' : 'Escribí un mensaje...'}
          rows={1}
          disabled={!connected || recording}
        />
        <button
          className="wc-btn-icon wc-tts-btn"
          onClick={playTTS}
          disabled={!connected || !messages.some(m => m.role === 'assistant')}
          title="Escuchar última respuesta (TTS)"
        >
          &#128264;
        </button>
        <button
          className="wc-send"
          onClick={sendMessage}
          disabled={!input.trim() || sending || !connected}
        >
          {sending ? '...' : '\u27A4'}
        </button>
      </div>
    </div>
  );
}
