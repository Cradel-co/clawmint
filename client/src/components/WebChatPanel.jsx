import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useChatStore } from '../stores/chatStore';
import { useProviders } from '../api/providers';
import { useAgents } from '../api/agents';
import useAudioRecorder from '../hooks/useAudioRecorder';
import useFileUpload from '../hooks/useFileUpload';
import ChatHeader from './chat/ChatHeader.jsx';
import StatusBar from './chat/StatusBar.jsx';
import MessageList from './chat/MessageList.jsx';
import ChatInput from './chat/ChatInput.jsx';
import AuthPanel from './AuthPanel.jsx';
import styles from './WebChatPanel.module.css';

export default function WebChatPanel({ onClose, embedded, onNewMessage, onStateChange }) {
  const { data: providersData } = useProviders();
  const { data: agentsList = [] } = useAgents();
  const providers = providersData?.providers || [];

  const { user: authUser, showAuthPanel, setShowAuthPanel, handleAuth, handleLogout, handleWsAuthMessage } = useAuth();

  // ── Chat state (Zustand store) ───────────────────────────────────────────────

  const {
    messages, input, setInput, sending, setSending,
    provider, setProvider, agent, setAgent, cwd,
    statusText, setStatusText, connected,
    addUserMessage, clearMessages, send, getSessionId, reconnect,
    setOnAuthMessage, setOnNewMessage,
  } = useChatStore();

  // Registrar callbacks de auth y new message en el store
  useEffect(() => {
    setOnAuthMessage(handleWsAuthMessage);
    setOnNewMessage(onNewMessage || null);
  }, [handleWsAuthMessage, onNewMessage, setOnAuthMessage, setOnNewMessage]);

  // Reportar cwd + provider al padre (para context bar en split mode)
  useEffect(() => { onStateChange?.({ cwd, provider }); }, [cwd, provider, onStateChange]);

  // Setear provider default cuando llegan los datos
  useEffect(() => {
    if (providersData?.default) setProvider(providersData.default);
  }, [providersData?.default]); // eslint-disable-line

  // ── Enviar mensaje ─────────────────────────────────────────────────────────

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;
    addUserMessage(text);
    setInput('');
    setSending(true);
    send({ type: 'chat', text, provider, agent });
  }, [input, sending, provider, agent, send, addUserMessage, setInput, setSending]);

  const clearChat = useCallback(() => {
    clearMessages();
    send({ type: 'chat', text: '/nueva', provider, agent });
  }, [provider, agent, send, clearMessages]);

  // ── Botones inline ─────────────────────────────────────────────────────────

  const handleButtonClick = useCallback((btn) => {
    const data = btn.callback_data || btn.data || btn.text || btn.label;
    send({ type: 'chat:action', data });
    setSending(true);
  }, [send, setSending]);

  // ── Audio ──────────────────────────────────────────────────────────────────

  const setError = useCallback((text, timeout = 5000) => {
    setStatusText(text);
    if (timeout) setTimeout(() => setStatusText(null), timeout);
  }, [setStatusText]);

  const handleRecordingComplete = useCallback(({ blob, audioUrl, audioDuration, mimeType }) => {
    addUserMessage('', { audioUrl, audioDuration, transcription: null });
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      setSending(true);
      send({ type: 'chat:audio', data: base64, mimeType });
    };
    reader.readAsDataURL(blob);
  }, [send, addUserMessage, setSending]);

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
  }, [messages, send, setStatusText]);

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
  }, [provider, agent, send, addUserMessage, setError, setInput, setSending]);

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
    <div className={styles.panel} onDrop={handleDrop} onDragOver={handleDragOver} role="region" aria-label="Panel de chat web">
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
        embedded={embedded}
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
