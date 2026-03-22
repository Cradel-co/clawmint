import { useState, useEffect, useRef, useCallback } from 'react';
import { API_BASE, WS_URL } from '../config.js';
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
  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

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
      ws.send(JSON.stringify({
        type: 'init',
        sessionType: 'webchat',
      }));
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'session_id':
            sessionIdRef.current = msg.id;
            break;

          case 'chat_chunk':
            // Streaming: actualizar último mensaje del asistente
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
            break;

          case 'chat_error':
            setMessages(prev => [
              ...prev,
              { role: 'system', content: `Error: ${msg.error}`, error: true },
            ]);
            setSending(false);
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

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || sending) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Mostrar mensaje del usuario
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setSending(true);

    ws.send(JSON.stringify({
      type: 'chat',
      text,
      provider,
      agent,
    }));
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

  const providerLabel = providers.find(p => p.name === provider)?.label || provider;

  return (
    <div className="wc-panel">
      <div className="wc-header">
        <span className="wc-header-title">💬 Chat</span>
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
          <button className="wc-btn-icon" onClick={clearChat} title="Nueva conversación">🗑️</button>
          <button className="wc-close" onClick={onClose}>×</button>
        </div>
      </div>

      <div className="wc-status-bar">
        <span className={`wc-dot ${connected ? 'on' : 'off'}`} />
        <span>{providerLabel}</span>
        {agent && <span> · {agent}</span>}
        <span className="wc-cwd"> · {cwd}</span>
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
          <div key={i} className={`wc-msg wc-msg-${msg.role} ${msg.error ? 'wc-msg-error' : ''}`}>
            {msg.role === 'assistant' && (
              <div className="wc-msg-label">{providerLabel}</div>
            )}
            <div className="wc-msg-content">
              {msg.content}
              {msg.streaming && <span className="wc-cursor">▊</span>}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="wc-input-area">
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
          className="wc-send"
          onClick={sendMessage}
          disabled={!input.trim() || sending || !connected}
        >
          {sending ? '...' : '➤'}
        </button>
      </div>
    </div>
  );
}
