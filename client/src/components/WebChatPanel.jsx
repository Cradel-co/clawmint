import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '../config.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import useChatSocket from '../hooks/useChatSocket.js';
import useAudioRecorder from '../hooks/useAudioRecorder.js';
import useFileUpload from '../hooks/useFileUpload.js';
import ChatHeader from './chat/ChatHeader.jsx';
import StatusBar from './chat/StatusBar.jsx';
import MessageList from './chat/MessageList.jsx';
import ChatInput from './chat/ChatInput.jsx';
import AuthPanel from './AuthPanel.jsx';
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
  const [statusText, setStatusText] = useState(null);

  const { user: authUser, showAuthPanel, setShowAuthPanel, handleAuth, handleLogout, handleWsAuthMessage, setWsRef } = useAuth();

  // ── WebSocket ──────────────────────────────────────────────────────────────

  const handleWsMessage = useCallback((msg) => {
    // Delegar mensajes de auth al contexto
    if (['session_id', 'auth:tokens', 'auth_error', 'session_taken'].includes(msg.type)) {
      handleWsAuthMessage(msg);
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
  }, [handleWsAuthMessage]);

  const { connected, send, getSessionId, reconnect, wsRef } = useChatSocket({
    onMessage: handleWsMessage,
    onAuthError: () => { handleLogout(); },
  });

  // Pasar wsRef al AuthContext para refresh proactivo
  useEffect(() => { setWsRef(wsRef.current); }, [connected, setWsRef, wsRef]);

  // ── Cargar providers y agentes ─────────────────────────────────────────────

  useEffect(() => {
    fetch(`${API_BASE}/api/providers`)
      .then(r => r.json())
      .then(data => {
        setProviders(data.providers || []);
        if (data.default) setProvider(data.default);
      })
      .catch(() => setStatusText('Error cargando providers'));
    fetch(`${API_BASE}/api/agents`)
      .then(r => r.json())
      .then(data => setAgentsList(Array.isArray(data) ? data : []))
      .catch(() => setStatusText('Error cargando agentes'));
  }, []);

  // ── Enviar mensaje ─────────────────────────────────────────────────────────

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setSending(true);
    send({ type: 'chat', text, provider, agent });
  }, [input, sending, provider, agent, send]);

  const clearChat = useCallback(() => {
    setMessages([]);
    send({ type: 'chat', text: '/nueva', provider, agent });
  }, [provider, agent, send]);

  // ── Botones inline ─────────────────────────────────────────────────────────

  const handleButtonClick = useCallback((btn) => {
    const data = btn.callback_data || btn.data || btn.text || btn.label;
    send({ type: 'chat:action', data });
    setSending(true);
  }, [send]);

  // ── Audio ──────────────────────────────────────────────────────────────────

  const handleRecordingComplete = useCallback(({ blob, audioUrl, audioDuration, mimeType }) => {
    setMessages(prev => [...prev, { role: 'user', audioUrl, audioDuration, transcription: null }]);
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      setSending(true);
      send({ type: 'chat:audio', data: base64, mimeType });
    };
    reader.readAsDataURL(blob);
  }, [send]);

  const recorder = useAudioRecorder({ onRecordingComplete: handleRecordingComplete });

  const handleStartRecording = useCallback(async () => {
    const result = await recorder.start();
    if (result?.error) {
      setStatusText(result.error);
      setTimeout(() => setStatusText(null), 5000);
    }
  }, [recorder]);

  // ── TTS ────────────────────────────────────────────────────────────────────

  const playTTS = useCallback(() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) return;
    send({ type: 'chat:tts', text: lastAssistant.content });
    setStatusText('Generando audio...');
  }, [messages, send]);

  // ── File upload ────────────────────────────────────────────────────────────

  const handleFile = useCallback(({ file, base64, mediaType, isImage, inputText, error }) => {
    if (error) {
      setStatusText(error);
      setTimeout(() => setStatusText(null), 5000);
      return;
    }
    if (isImage) {
      const text = inputText || 'Describe esta imagen';
      setMessages(prev => [...prev, { role: 'user', content: `[Imagen: ${file.name}] ${text}` }]);
      setInput('');
      setSending(true);
      send({ type: 'chat', text, provider, agent, images: [{ base64, mediaType }] });
    } else {
      const text = inputText || 'Analiza este archivo';
      setMessages(prev => [...prev, { role: 'user', content: `[Archivo: ${file.name}] ${text}` }]);
      setInput('');
      setSending(true);
      send({ type: 'chat', text, provider, agent, files: [{ base64, mediaType, name: file.name }] });
    }
  }, [provider, agent, send]);

  const { fileInputRef, openPicker, handleFileSelect, handleDrop, handleDragOver } = useFileUpload({ onFile: handleFile });

  // ── Auth handlers ──────────────────────────────────────────────────────────

  const onAuth = useCallback(async (result) => {
    await handleAuth(result, getSessionId());
    reconnect();
  }, [handleAuth, getSessionId, reconnect]);

  const onLogout = useCallback(() => {
    handleLogout();
    reconnect();
  }, [handleLogout, reconnect]);

  const handleSettingsChange = useCallback((settings) => {
    send({ type: 'chat:settings', ...settings });
  }, [send]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const providerLabel = providers.find(p => p.name === provider)?.label || provider;

  return (
    <div className="wc-panel" onDrop={handleDrop} onDragOver={handleDragOver} role="region" aria-label="Panel de chat web">
      <ChatHeader
        providers={providers}
        provider={provider}
        setProvider={setProvider}
        agentsList={agentsList}
        agent={agent}
        setAgent={setAgent}
        authUser={authUser}
        onLogout={onLogout}
        onShowAuth={() => setShowAuthPanel(true)}
        onClear={clearChat}
        onClose={onClose}
        onSettingsChange={handleSettingsChange}
      />

      <StatusBar
        connected={connected}
        providerLabel={providerLabel}
        agent={agent}
        cwd={cwd}
        statusText={statusText}
      />

      {showAuthPanel && (
        <AuthPanel
          onAuth={onAuth}
          onSkip={() => setShowAuthPanel(false)}
        />
      )}

      {!showAuthPanel && (
        <MessageList
          messages={messages}
          sending={sending}
          connected={connected}
          providerLabel={providerLabel}
          onButtonClick={handleButtonClick}
        />
      )}

      {!showAuthPanel && (
        <ChatInput
          input={input}
          setInput={setInput}
          connected={connected}
          sending={sending}
          onSend={sendMessage}
          onPlayTTS={playTTS}
          hasTTSContent={messages.some(m => m.role === 'assistant')}
          recording={recorder.recording}
          recPaused={recorder.recPaused}
          recTime={recorder.recTime}
          onStartRecording={handleStartRecording}
          onCancelRecording={recorder.cancel}
          onTogglePause={recorder.togglePause}
          onSendRecording={recorder.send}
          fileInputRef={fileInputRef}
          onOpenFilePicker={openPicker}
          onFileSelect={handleFileSelect}
        />
      )}
    </div>
  );
}
