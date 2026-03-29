import { create } from 'zustand';
import { WsManager } from '../lib/wsManager';
import { WS_URL } from '../config';
import { getStoredTokens, clearStoredTokens, isTokenExpired, refreshTokens } from '../authUtils';

const MAX_MESSAGES = 500;

export const useChatStore = create((set, get) => ({
  messages: [],
  input: '',
  sending: false,
  provider: 'anthropic',
  agent: null,
  cwd: '~',
  statusText: null,
  connected: false,

  _onAuthMessage: null,
  _onNewMessage: null,
  _wsManager: null,
  _sessionId: null,
  _sendingTimer: null,

  setInput: (v) => set({ input: v }),
  setProvider: (v) => set({ provider: v }),
  setAgent: (v) => set({ agent: v }),
  setSending: (v) => {
    set({ sending: v });
    const state = get();
    // Safety net: limpiar typing después de 2 min
    if (v) {
      if (state._sendingTimer) clearTimeout(state._sendingTimer);
      const timer = setTimeout(() => {
        const s = get();
        if (!s.sending) return;
        set((prev) => {
          const last = prev.messages[prev.messages.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            return {
              sending: false, statusText: null, _sendingTimer: null,
              messages: [...prev.messages.slice(0, -1), { ...last, content: last.content || 'Error: el provider no respondió a tiempo.', streaming: false }],
            };
          }
          return {
            sending: false, statusText: null, _sendingTimer: null,
            messages: [...prev.messages, { role: 'system', content: 'Error: el provider no respondió a tiempo.', error: true }],
          };
        });
      }, 120000);
      set({ _sendingTimer: timer });
    } else {
      if (state._sendingTimer) {
        clearTimeout(state._sendingTimer);
        set({ _sendingTimer: null });
      }
    }
  },
  setStatusText: (v) => set({ statusText: v }),

  addUserMessage: (content, extra = {}) => {
    set((s) => ({
      messages: [...s.messages.slice(-MAX_MESSAGES + 1), { role: 'user', content, ...extra }],
    }));
  },

  clearMessages: () => set({ messages: [] }),

  setOnAuthMessage: (fn) => set({ _onAuthMessage: fn }),
  setOnNewMessage: (fn) => set({ _onNewMessage: fn }),

  send: (data) => {
    get()._wsManager?.send(data);
  },

  getSessionId: () => get()._sessionId,

  reconnect: () => {
    get()._wsManager?.reconnect();
  },

  _init: () => {
    const manager = new WsManager({
      url,
      buildInitPayload: () => {
        const savedSessionId = localStorage.getItem('wc-session-id');
        const authToken = localStorage.getItem('wc-auth-token') || undefined;
        const { accessToken } = getStoredTokens();
        return {
          type: 'init',
          sessionType: 'webchat',
          ...(savedSessionId ? { sessionId: savedSessionId } : {}),
          ...(authToken ? { authToken } : {}),
          ...(accessToken && !isTokenExpired(accessToken) ? { jwt: accessToken } : {}),
        };
      },
      onStatusChange: (connected) => set({ connected }),
    });

    // Refresh token antes de reconectar si expiró
    const origConnect = manager.connect.bind(manager);
    manager.connect = async () => {
      const { accessToken } = getStoredTokens();
      if (accessToken && isTokenExpired(accessToken)) {
        try { await refreshAuthTokens(); } catch { clearStoredTokens(); }
      }
      origConnect();
    };

    // ── Handlers por tipo de mensaje ──────────────────────────────────────

    manager.subscribe('session_id', (msg) => {
      set({ _sessionId: msg.id });
      localStorage.setItem('wc-session-id', msg.id);
      get()._onAuthMessage?.(msg);
    });

    manager.subscribe('auth:tokens', (msg) => get()._onAuthMessage?.(msg));
    manager.subscribe('auth_error', (msg) => {
      get()._onAuthMessage?.(msg);
      set({ messages: [{ role: 'system', content: msg.error || 'Error de autenticación', error: true }] });
    });
    manager.subscribe('session_taken', (msg) => {
      get()._onAuthMessage?.(msg);
      set((s) => ({
        messages: [...s.messages.slice(-MAX_MESSAGES + 1), {
          role: 'system', content: msg.message || 'Sesión abierta desde otro dispositivo', error: true,
        }],
      }));
    });

    manager.subscribe('chat_chunk', (msg) => {
      set((s) => {
        const last = s.messages[s.messages.length - 1];
        if (last && last.role === 'assistant' && last.streaming) {
          return { messages: [...s.messages.slice(0, -1), { ...last, content: msg.text }] };
        }
        return { messages: [...s.messages.slice(-MAX_MESSAGES + 1), { role: 'assistant', content: msg.text, streaming: true }] };
      });
    });

    const handleChatDone = (msg) => {
      set((s) => {
        const last = s.messages[s.messages.length - 1];
        const entry = { content: msg.text, streaming: false, ...(msg.buttons ? { buttons: msg.buttons } : {}) };
        if (last && last.role === 'assistant' && last.streaming) {
          return { messages: [...s.messages.slice(0, -1), { ...last, ...entry }], sending: false, statusText: null };
        }
        return { messages: [...s.messages.slice(-MAX_MESSAGES + 1), { role: 'assistant', ...entry }], sending: false, statusText: null };
      });
      // Clear safety timer
      const timer = get()._sendingTimer;
      if (timer) { clearTimeout(timer); set({ _sendingTimer: null }); }
      get()._onNewMessage?.();
    };
    manager.subscribe('chat_done', handleChatDone);
    manager.subscribe('chat:message', handleChatDone);

    manager.subscribe('chat_error', (msg) => {
      set((s) => ({
        messages: [...s.messages.slice(-MAX_MESSAGES + 1), { role: 'system', content: `Error: ${msg.error}`, error: true }],
        sending: false, statusText: null,
      }));
      const timer = get()._sendingTimer;
      if (timer) { clearTimeout(timer); set({ _sendingTimer: null }); }
    });

    manager.subscribe('command_result', (msg) => {
      set((s) => ({
        messages: [...s.messages.slice(-MAX_MESSAGES + 1), { role: 'system', content: msg.text }],
        sending: false,
        ...(msg.provider ? { provider: msg.provider } : {}),
        ...(msg.agent !== undefined ? { agent: msg.agent } : {}),
        ...(msg.cwd ? { cwd: msg.cwd } : {}),
      }));
    });

    manager.subscribe('history_restore', (msg) => {
      if (Array.isArray(msg.messages) && msg.messages.length > 0) {
        set({ messages: msg.messages.map((m) => ({ role: m.role, content: m.content, streaming: false })) });
      }
    });

    manager.subscribe('chat:transcription', (msg) => {
      set((s) => {
        const idx = s.messages.findLastIndex((m) => m.role === 'user' && m.audioUrl);
        if (idx >= 0) {
          const updated = [...s.messages];
          updated[idx] = { ...updated[idx], transcription: msg.text };
          return { messages: updated };
        }
        return { messages: [...s.messages.slice(-MAX_MESSAGES + 1), { role: 'user', content: msg.text }] };
      });
    });

    const handleStatus = (msg) => {
      if (msg.status === 'thinking') set({ statusText: msg.detail ? `🤔 ${msg.detail}...` : '🤔 Pensando...' });
      else if (msg.status === 'tool_use') set({ statusText: `⚡ ${msg.detail || 'Ejecutando tool'}...` });
      else if (msg.status === 'transcribing') set({ statusText: 'Transcribiendo...' });
      else if (msg.status === 'synthesizing') set({ statusText: 'Generando audio...' });
      else set({ statusText: null });
    };
    manager.subscribe('chat_status', handleStatus);
    manager.subscribe('chat:status', handleStatus);

    manager.subscribe('chat_ask_permission', (msg) => {
      set((s) => ({
        messages: [...s.messages.slice(-MAX_MESSAGES + 1), {
          role: 'system',
          content: `🔐 Permiso requerido — herramienta: ${msg.tool}\n${msg.args}`,
          askPermission: true,
          buttons: [
            { text: '✅ Aprobar', callback_data: msg.approveId },
            { text: '❌ Rechazar', callback_data: msg.rejectId },
          ],
        }],
      }));
    });

    manager.subscribe('chat:tts_audio', (msg) => {
      const audioUrl = `data:${msg.mimeType || 'audio/wav'};base64,${msg.data}`;
      set((s) => ({
        messages: [...s.messages.slice(-MAX_MESSAGES + 1), { role: 'tts', audioUrl }],
        statusText: null,
      }));
    });

    manager.subscribe('chat:tts_error', (msg) => {
      set((s) => ({
        statusText: null,
        messages: [...s.messages.slice(-MAX_MESSAGES + 1), { role: 'system', content: `TTS: ${msg.error || 'No disponible'}`, error: true }],
      }));
    });

    const handleMedia = (msg) => {
      const mimeMap = {
        'chat:photo': 'image/png', 'chat:document': 'application/octet-stream',
        'chat:voice': 'audio/ogg', 'chat:video': 'video/mp4',
      };
      const mediaTypeMap = {
        'chat:photo': 'photo', 'chat:document': 'document',
        'chat:voice': 'voice', 'chat:video': 'video',
      };
      const src = `data:${msg.mimeType || mimeMap[msg.type] || 'application/octet-stream'};base64,${msg.data}`;
      set((s) => ({
        messages: [...s.messages.slice(-MAX_MESSAGES + 1), {
          role: 'assistant', msgId: msg.msgId,
          mediaType: mediaTypeMap[msg.type],
          mediaSrc: src, caption: msg.caption, filename: msg.filename,
          ...(msg.type === 'chat:document' || msg.type === 'chat:video' ? { mimeType: msg.mimeType } : {}),
        }],
        sending: false, statusText: null,
      }));
    };
    manager.subscribe('chat:photo', handleMedia);
    manager.subscribe('chat:document', handleMedia);
    manager.subscribe('chat:voice', handleMedia);
    manager.subscribe('chat:video', handleMedia);

    manager.subscribe('chat:delete', (msg) => {
      set((s) => ({ messages: s.messages.filter((m) => m.msgId !== msg.msgId) }));
    });

    manager.subscribe('chat:edit', (msg) => {
      set((s) => ({ messages: s.messages.map((m) => m.msgId === msg.msgId ? { ...m, content: msg.text } : m) }));
    });

    manager.subscribe('status', (msg) => {
      set({
        ...(msg.provider ? { provider: msg.provider } : {}),
        ...(msg.agent !== undefined ? { agent: msg.agent } : {}),
        ...(msg.cwd ? { cwd: msg.cwd } : {}),
      });
    });

    set({ _wsManager: manager });
    manager.connect();
  },
}));

// Auto-inicializar al importar
useChatStore.getState()._init();
