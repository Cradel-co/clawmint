import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useChatStore } from '../stores/chatStore';
import { useProviders } from '../api/providers';
import { useAgents } from '../api/agents';
import useAudioRecorder from '../hooks/useAudioRecorder';
import useFileUpload from '../hooks/useFileUpload';
import { getStoredTokens } from '../authUtils';
import { API_BASE } from '../config';
import ChatHeader from './chat/ChatHeader.jsx';
import StatusBar from './chat/StatusBar.jsx';
import MessageList from './chat/MessageList.jsx';
import ChatInput from './chat/ChatInput.jsx';
import ChatHistory from './chat/ChatHistory.jsx';
import AuthPanel from './AuthPanel.jsx';
import styles from './WebChatPanel.module.css';

export default function WebChatPanel({ onClose, embedded, onNewMessage, onStateChange }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: providersData } = useProviders();
  const { data: agentsList = [] } = useAgents();
  const providers = providersData?.providers || [];

  const { user: authUser, showAuthPanel, setShowAuthPanel, handleAuth, handleLogout, handleWsAuthMessage } = useAuth();

  // ── Chat state (Zustand store) ───────────────────────────────────────────────

  const {
    messages, input, setInput, sending, setSending,
    provider, setProvider, agent, setAgent, cwd,
    claudeMode, setClaudeMode, webSearch, setWebSearch,
    statusText, setStatusText, connected, mode,
    addUserMessage, clearMessages, send, getSessionId, reconnect,
    setOnAuthMessage, setOnNewMessage, switchSession, newSession,
  } = useChatStore();

  const [skills, setSkills] = useState([]);
  useEffect(() => {
    const tokens = getStoredTokens();
    if (!tokens?.accessToken) return;
    fetch(`${API_BASE}/api/skills`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } })
      .then(r => r.ok ? r.json() : { skills: [] })
      .then(d => setSkills(Array.isArray(d) ? d : (d.skills || [])))
      .catch(() => {});
  }, [authUser]);

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
    const raw = input.trim();
    if (!raw || sending) return;
    const text = webSearch
      ? `Usá websearch para investigar esto en internet y respondé con fuentes.\n\n${raw}`
      : raw;
    addUserMessage(raw);
    setInput('');
    setSending(true);
    send({ type: 'chat', text, provider, agent });
    if (webSearch) setWebSearch(false);
  }, [input, sending, provider, agent, webSearch, send, addUserMessage, setInput, setSending, setWebSearch]);

  const clearChat = useCallback(() => {
    newSession();
  }, [newSession]);

  const handleSuggestion = useCallback((text) => {
    setInput(text);
  }, [setInput]);

  const handleLoadSession = useCallback((sessionId) => {
    switchSession(sessionId);
    setHistoryOpen(false);
  }, [switchSession]);

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

  // ── Tool menu handlers ────────────────────────────────────────────────────

  const handleModeChange = useCallback((mode) => {
    setClaudeMode(mode);
    addUserMessage(`/modo ${mode}`);
    send({ type: 'chat', text: `/modo ${mode}` });
  }, [setClaudeMode, addUserMessage, send]);

  const handleProviderChange = useCallback((p) => {
    setProvider(p);
    handleSettingsChange({ provider: p });
  }, [setProvider, handleSettingsChange]);

  const handleAgentChange = useCallback((a) => {
    setAgent(a);
    handleSettingsChange({ agent: a });
  }, [setAgent, handleSettingsChange]);

  const handleCdChange = useCallback((path) => {
    addUserMessage(`/cd ${path}`);
    send({ type: 'chat', text: `/cd ${path}` });
  }, [addUserMessage, send]);

  const handleNew = useCallback(() => { newSession(); }, [newSession]);

  const handleShowCost = useCallback(() => {
    addUserMessage('Decime el costo estimado de esta sesión: tokens de entrada/salida y dolares.');
    setSending(true);
    send({ type: 'chat', text: 'Decime el costo estimado de esta sesión: tokens de entrada/salida y dolares.', provider, agent });
  }, [addUserMessage, setSending, send, provider, agent]);

  const handleInvokeSkill = useCallback((skillName) => {
    const text = `Ejecutá el skill "${skillName}".`;
    addUserMessage(text);
    setSending(true);
    send({ type: 'chat', text, provider, agent });
  }, [addUserMessage, setSending, send, provider, agent]);

  const handlePasteClipboard = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const file = new File([blob], `clipboard.${imageType.split('/')[1] || 'png'}`, { type: imageType });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          handleFile({ file, base64, mediaType: imageType, isImage: true, inputText: input.trim() });
        };
        reader.readAsDataURL(file);
        return;
      }
      setError('No hay imagen en el portapapeles');
    } catch (err) {
      setError('No se pudo leer el portapapeles: ' + err.message);
    }
  }, [handleFile, input, setError]);

  const handleWebcam = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      stream.getTracks().forEach(t => t.stop());
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      const file = new File([blob], 'webcam.jpg', { type: 'image/jpeg' });
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        handleFile({ file, base64, mediaType: 'image/jpeg', isImage: true, inputText: input.trim() });
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setError('No se pudo acceder a la cámara: ' + err.message);
    }
  }, [handleFile, input, setError]);

  const handleScreenshotRemote = useCallback(() => {
    const text = 'Tomá una captura de la pantalla del PC remoto con critter_screenshot y describí brevemente lo que ves.';
    addUserMessage('📸 Captura del PC remoto');
    setSending(true);
    send({ type: 'chat', text, provider, agent });
  }, [addUserMessage, setSending, send, provider, agent]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const providerLabel = providers.find(p => p.name === provider)?.label || provider;

  return (
    <div className={styles.panel} onDrop={handleDrop} onDragOver={handleDragOver} role="region" aria-label="Panel de chat web">
      <ChatHistory
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelect={handleLoadSession}
        onNew={(opts) => { setHistoryOpen(false); newSession(opts || {}); }}
        currentSessionId={getSessionId()}
      />
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
        onOpenHistory={() => setHistoryOpen(true)}
        embedded={embedded}
      />

      <StatusBar
        connected={connected}
        providerLabel={providerLabel}
        agent={agent}
        cwd={cwd}
        statusText={statusText}
        mode={mode}
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
          onSuggestion={handleSuggestion}
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
          claudeMode={claudeMode}
          onModeChange={handleModeChange}
          webSearch={webSearch}
          onWebSearchToggle={setWebSearch}
          providers={providers}
          provider={provider}
          onProviderChange={handleProviderChange}
          agentsList={agentsList}
          agent={agent}
          onAgentChange={handleAgentChange}
          cwd={cwd}
          skills={skills}
          onWebcam={handleWebcam}
          onScreenshotRemote={handleScreenshotRemote}
          onPasteClipboard={handlePasteClipboard}
          onCdChange={handleCdChange}
          onNew={handleNew}
          onShowCost={handleShowCost}
          onInvokeSkill={handleInvokeSkill}
        />
      )}
    </div>
  );
}
