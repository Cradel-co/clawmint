import { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '../config';
import { useAuth } from '../contexts/AuthContext.jsx';
import { apiFetch } from '../authUtils';
import useChatSocket from '../hooks/useChatSocket.js';
import useChat from '../hooks/useChat.js';
import useAudioRecorder from '../hooks/useAudioRecorder.js';
import useFileUpload from '../hooks/useFileUpload.js';
import ChatHeader from './chat/ChatHeader.jsx';
import StatusBar from './chat/StatusBar.jsx';
import MessageList from './chat/MessageList.jsx';
import ChatInput from './chat/ChatInput.jsx';
import AuthPanel from './AuthPanel.jsx';
import './WebChatPanel.css';

export default function WebChatPanel({ onClose }) {
  const [providers, setProviders] = useState([]);
  const [agentsList, setAgentsList] = useState([]);

  const { user: authUser, showAuthPanel, setShowAuthPanel, handleAuth, handleLogout, handleWsAuthMessage, setWsRef } = useAuth();

  // ── Chat state (useChat hook) ──────────────────────────────────────────────

  const {
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
  } = useChat({ onAuthMessage: handleWsAuthMessage });

  const { connected, send, getSessionId, reconnect, wsRef } = useChatSocket({
    onMessage: handleWsMessage,
    onAuthError: () => { handleLogout(); },
  });

  // Pasar wsRef al AuthContext para refresh proactivo
  useEffect(() => { setWsRef(wsRef.current); }, [connected, setWsRef, wsRef]);

  // ── Cargar providers y agentes ─────────────────────────────────────────────

  useEffect(() => {
    apiFetch(`${API_BASE}/api/providers`)
      .then(r => r.json())
      .then(data => {
        setProviders(data.providers || []);
        if (data.default) setProvider(data.default);
      })
      .catch(() => setStatusText('Error cargando providers'));
    apiFetch(`${API_BASE}/api/agents`)
      .then(r => r.json())
      .then(data => setAgentsList(Array.isArray(data) ? data : []))
      .catch(() => setStatusText('Error cargando agentes'));
  }, []);

  // ── Enviar mensaje ─────────────────────────────────────────────────────────

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;
    addUserMessage(text);
    setInput('');
    setSending(true);
    send({ type: 'chat', text, provider, agent });
  }, [input, sending, provider, agent, send, addUserMessage]);

  const clearChat = useCallback(() => {
    clearMessages();
    send({ type: 'chat', text: '/nueva', provider, agent });
  }, [provider, agent, send, clearMessages]);

  // ── Botones inline ─────────────────────────────────────────────────────────

  const handleButtonClick = useCallback((btn) => {
    const data = btn.callback_data || btn.data || btn.text || btn.label;
    send({ type: 'chat:action', data });
    setSending(true);
  }, [send]);

  // ── Audio ──────────────────────────────────────────────────────────────────

  const handleRecordingComplete = useCallback(({ blob, audioUrl, audioDuration, mimeType }) => {
    addUserMessage('', { audioUrl, audioDuration, transcription: null });
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      setSending(true);
      send({ type: 'chat:audio', data: base64, mimeType });
    };
    reader.readAsDataURL(blob);
  }, [send, addUserMessage]);

  const recorder = useAudioRecorder({ onRecordingComplete: handleRecordingComplete });

  const handleStartRecording = useCallback(async () => {
    const result = await recorder.start();
    if (result?.error) setError(result.error);
  }, [recorder, setError]);

  // ── TTS ────────────────────────────────────────────────────────────────────

  const playTTS = useCallback(() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    if (!lastAssistant) return;
    send({ type: 'chat:tts', text: lastAssistant.content });
    setStatusText('Generando audio...');
  }, [messages, send]);

  // ── File upload ────────────────────────────────────────────────────────────

  const handleFile = useCallback(({ file, base64, mediaType, isImage, inputText, error }) => {
    if (error) { setError(error); return; }
    if (isImage) {
      const text = inputText || 'Describe esta imagen';
      addUserMessage(`[Imagen: ${file.name}] ${text}`);
      setInput('');
      setSending(true);
      send({ type: 'chat', text, provider, agent, images: [{ base64, mediaType }] });
    } else {
      const text = inputText || 'Analiza este archivo';
      addUserMessage(`[Archivo: ${file.name}] ${text}`);
      setInput('');
      setSending(true);
      send({ type: 'chat', text, provider, agent, files: [{ base64, mediaType, name: file.name }] });
    }
  }, [provider, agent, send, addUserMessage, setError]);

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
