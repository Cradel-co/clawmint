'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const BaseChannel    = require('../BaseChannel');
const parseButtons   = require('../parseButtons');

// Patrones de texto meta/interno que la IA genera pero no deben enviarse al usuario
const NOISE_PATTERNS = [
  /^no\s+response\s+(requested|needed|required)/i,
  /^continue\s+from\s+where\s+you\s+left/i,
  /^waiting\s+for\s+(the\s+)?user/i,
  /^no\s+action\s+(needed|required|necessary)/i,
  /^nothing\s+(else\s+)?to\s+(do|say|add|respond)/i,
  /^the\s+(user\s+)?(was|has\s+been)\s+(notified|informed)/i,
  /^message\s+sent\s+(successfully|to\s+the\s+user)/i,
  /^already\s+(sent|responded|replied)/i,
  /^(i('ve| have)|the\s+)?\s*(response|message|answer)\s+(was\s+)?(already\s+)?sent/i,
];
function isNoiseText(text) {
  const t = (text || '').trim();
  if (!t) return true;
  if (t.length > 300) return false;
  return NOISE_PATTERNS.some(rx => rx.test(t));
}

/** Tiempo que una sesión desconectada se mantiene en memoria (30 min) */
const PARK_TTL_MS = 30 * 60 * 1000;

/** Intervalo de limpieza de sesiones expiradas (5 min) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * WebChannel — canal de chat web nativo por WebSocket.
 *
 * Extiende BaseChannel y coexiste con TelegramChannel.
 * Cada conexión WS crea una sesión de chat independiente
 * con su propio estado (provider, agente, modelo, historial).
 *
 * Fase 2: soporta botones inline, audio (transcripción + TTS),
 * y upload de imágenes.
 */
class WebChannel extends BaseChannel {
  constructor({ convSvc, providers, providerConfig, agents, chatSettingsRepo, messagesRepo, eventBus, logger, transcriber, tts, usersRepo, authService, scheduler } = {}) {
    super({ eventBus, logger });
    this.convSvc          = convSvc;
    this.providers        = providers;
    this.providerConfig   = providerConfig;
    this.agents           = agents;
    this.chatSettingsRepo = chatSettingsRepo;
    this.messagesRepo     = messagesRepo;
    this.transcriber      = transcriber;
    this.tts              = tts;
    this._usersRepo       = usersRepo || null;
    this._authService     = authService || null;
    this._scheduler       = scheduler || null;
    /** @type {Map<string, object>} sessionId → { ws, state } */
    this.sessions         = new Map();
    /** @type {Map<string, { state: object, parkedAt: number }>} */
    this._parked          = new Map();
    this._cleanupTimer    = null;
  }

  static BOT_KEY = 'web';

  async start() {
    this._cleanupTimer = setInterval(() => this._cleanupParked(), CLEANUP_INTERVAL_MS);
    this._cleanupTimer.unref();
    this.logger.info('[WebChannel] Canal web iniciado');
  }

  async stop() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    for (const [, session] of this.sessions) {
      try { session.ws.close(); } catch {}
    }
    this.sessions.clear();
    this._parked.clear();
    this.logger.info('[WebChannel] Canal web detenido');
  }

  // ── Autenticación ─────────────────────────────────────────────────────────

  _checkAuth(opts) {
    const token = process.env.WEB_AUTH_TOKEN;
    if (!token) return true;
    return opts.authToken === token;
  }

  // ── Conexión ──────────────────────────────────────────────────────────────

  handleConnection(ws, opts = {}) {
    if (!this._checkAuth(opts)) {
      this._sendJson(ws, { type: 'auth_error', error: 'Token inválido o ausente.' });
      ws.close(4001, 'Unauthorized');
      return;
    }

    // ── Autenticación JWT (opcional) ──────────────────────────────────────────
    let authUser = null;
    if (opts.jwt && this._authService) {
      const payload = this._authService.verifyAccessToken(opts.jwt);
      if (payload) {
        authUser = this._authService.getUserById(payload.sub);
      } else {
        this._sendJson(ws, { type: 'auth_error', error: 'Token JWT expirado o inválido.', code: 'TOKEN_EXPIRED' });
        ws.close(4003, 'JWT expired');
        return;
      }
    }

    // Si hay usuario autenticado, usar userId como sessionId para cross-device
    const sessionId = authUser ? authUser.id : (opts.sessionId || crypto.randomUUID());
    this._sendJson(ws, {
      type: 'session_id',
      id: sessionId,
      ...(authUser ? { user: { id: authUser.id, name: authUser.name, email: authUser.email, avatar_url: authUser.avatar_url } } : {}),
    });

    // Auto-crear usuario en el sistema unificado (solo para anónimos)
    if (this._usersRepo && !authUser) {
      try {
        this._usersRepo.getOrCreate('web', sessionId, opts.userName || 'Web User', 'web');
      } catch { /* no bloquear */ }
    }

    // Entregar mensajes pendientes
    if (this._scheduler) {
      this._scheduler.deliverPending('web', sessionId).catch(() => {});
    }

    // Suscribir a eventos de orquestación
    if (this.eventBus) {
      const orchListener = (data) => {
        if (ws.readyState === ws.OPEN) this._sendJson(ws, { type: 'orchestration_event', ...data });
      };
      const orchEvents = ['orchestration:start', 'orchestration:task', 'orchestration:done'];
      for (const evt of orchEvents) this.eventBus.on(evt, orchListener);
      ws.on('close', () => { for (const evt of orchEvents) this.eventBus.removeListener(evt, orchListener); });
    }

    // ── Takeover: si ya hay sesión activa con este sessionId (otro device) ────
    const existing = this.sessions.get(sessionId);
    if (existing && existing.ws !== ws) {
      // Notificar al device anterior y cerrar su WS
      try {
        this._sendJson(existing.ws, { type: 'session_taken', message: 'Sesión abierta desde otro dispositivo' });
        existing.ws.close(4002, 'Session taken');
      } catch { /* ws ya cerrado */ }
      // Reusar el state existente
      const state = existing.state;
      state.processing = false;
      this.sessions.set(sessionId, { ws, state });
      this._sendStatus(ws, state);
      this._sendHistory(ws, state);
      this._bindWs(ws, sessionId, state);
      this.logger.info(`[WebChannel] Sesión ${sessionId.slice(0, 8)} takeover (cross-device)`);
      return;
    }

    // Restaurar sesión parked
    const parked = this._parked.get(sessionId);
    if (parked) {
      this._parked.delete(sessionId);
      const state = parked.state;
      state.processing = false;
      // Fallback: si historial RAM está vacío, cargar de SQLite
      if (state.history.length === 0) {
        const dbMessages = this.messagesRepo?.load(sessionId) || [];
        if (dbMessages.length > 0) state.history = dbMessages;
      }
      this.sessions.set(sessionId, { ws, state });
      this._sendStatus(ws, state);
      this._sendHistory(ws, state);
      this._bindWs(ws, sessionId, state);
      this.logger.info(`[WebChannel] Sesión ${sessionId.slice(0, 8)} restaurada (${state.history.length} msgs)`);
      return;
    }

    // Cargar settings persistidos de SQLite
    const saved = this.chatSettingsRepo?.load(WebChannel.BOT_KEY, sessionId) || null;

    // Cargar historial de mensajes de SQLite
    const savedMessages = this.messagesRepo?.load(sessionId) || [];

    // Resolver userId del sistema unificado
    let sysUserId = authUser ? authUser.id : null;
    if (!sysUserId && this._usersRepo) {
      const sysUser = this._usersRepo.findByIdentity('web', sessionId);
      if (sysUser) sysUserId = sysUser.id;
    }

    const state = {
      provider: saved?.provider || opts.provider || this.providerConfig?.getConfig()?.default || 'anthropic',
      agent: opts.agent || null,
      model: saved?.model || null,
      history: savedMessages,
      claudeSession: saved?.claude_session_id || null,
      claudeMode: saved?.claude_mode || 'auto',
      cwd: saved?.cwd || process.env.HOME || '~',
      processing: false,
      userId: sysUserId,
    };

    this.sessions.set(sessionId, { ws, state });
    if (!saved) this._saveSettings(sessionId, state);
    this._sendStatus(ws, state);
    if (savedMessages.length > 0) this._sendHistory(ws, state);
    this._bindWs(ws, sessionId, state);
    this.logger.info(`[WebChannel] Sesión ${sessionId.slice(0, 8)} ${savedMessages.length > 0 ? 'restaurada' : 'nueva'} (provider: ${state.provider}, msgs: ${savedMessages.length})`);
  }

  /** Vincula handlers de WS a una sesión */
  _bindWs(ws, sessionId, state) {
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);

        switch (msg.type) {
          case 'chat': {
            if (state.processing) return;
            const text = (msg.text || '').trim();
            if (!text) return;

            if (msg.provider) state.provider = msg.provider;
            if (msg.agent !== undefined) state.agent = msg.agent || null;

            if (text.startsWith('/')) {
              this._handleCommand(ws, sessionId, state, text);
              return;
            }

            // Archivos adjuntos al mensaje
            const images = Array.isArray(msg.images) ? msg.images : null;
            const files  = Array.isArray(msg.files) ? msg.files : null;
            await this._sendToAI(ws, sessionId, state, text, images, files);
            break;
          }

          case 'chat:action': {
            // Click en botón inline → check dynamic callbacks, luego fallback
            const action = (msg.data || msg.text || '').trim();
            if (!action || state.processing) return;

            // Intentar callback dinámico primero
            const dynamicRegistry = require('../telegram/DynamicCallbackRegistry');
            const cb = dynamicRegistry.get(action);
            if (cb) {
              await this._executeDynamicCallback(ws, sessionId, state, cb);
              break;
            }

            if (action.startsWith('/')) {
              this._handleCommand(ws, sessionId, state, action);
            } else {
              await this._sendToAI(ws, sessionId, state, action);
            }
            break;
          }

          case 'chat:audio': {
            // Audio en base64 → transcribir → procesar como texto
            if (state.processing) return;
            await this._handleAudio(ws, sessionId, state, msg.data, msg.mimeType || 'audio/webm');
            break;
          }

          case 'chat:tts': {
            // Solicitud de TTS para un texto
            await this._handleTTS(ws, msg.text);
            break;
          }

          case 'auth:refresh': {
            // Renovar tokens JWT sin reconectar
            if (!this._authService || !msg.refreshToken) break;
            try {
              const tokens = this._authService.refreshTokens(msg.refreshToken);
              this._sendJson(ws, { type: 'auth:tokens', ...tokens });
            } catch (err) {
              this._sendJson(ws, { type: 'auth_error', error: err.message, code: 'REFRESH_FAILED' });
            }
            break;
          }

          case 'chat:settings': {
            // Sync de settings desde el dropdown del cliente
            if (msg.provider) {
              const p = this.providers.get(msg.provider);
              if (p) {
                state.provider = msg.provider;
                state.history = [];
                try { this.messagesRepo?.clear(sessionId); } catch {}
                this._saveSettings(sessionId, state);
              }
            }
            if (msg.agent !== undefined) {
              state.agent = msg.agent || null;
              this._saveSettings(sessionId, state);
            }
            break;
          }

          default:
            break;
        }
      } catch (err) {
        this._sendJson(ws, { type: 'chat_error', error: err.message || 'Error interno' });
        state.processing = false;
      }
    });

    ws.on('close', () => {
      this.sessions.delete(sessionId);
      this._parked.set(sessionId, { state, parkedAt: Date.now() });
      this.logger.info(`[WebChannel] Sesión ${sessionId.slice(0, 8)} parked (grace period: ${PARK_TTL_MS / 60000} min)`);
    });
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  async _handleAudio(ws, sessionId, state, base64Data, mimeType) {
    if (!base64Data) {
      this._sendJson(ws, { type: 'chat_error', error: 'Audio vacío.' });
      return;
    }

    if (!this.transcriber) {
      this._sendJson(ws, { type: 'chat_error', error: 'Transcriber no disponible.' });
      return;
    }

    state.processing = true;
    this._sendJson(ws, { type: 'chat:status', status: 'transcribing' });

    try {
      const ext = mimeType.includes('webm') ? '.webm' : mimeType.includes('ogg') ? '.ogg' : '.wav';
      const tmpFile = path.join(os.tmpdir(), `wc_audio_${Date.now()}${ext}`);
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(tmpFile, buffer);

      const text = await this.transcriber.transcribe(tmpFile);

      // Limpiar temp
      try { fs.unlinkSync(tmpFile); } catch {}

      if (!text || !text.trim()) {
        this._sendJson(ws, { type: 'chat_error', error: 'No se pudo transcribir el audio.' });
        state.processing = false;
        return;
      }

      // Enviar texto transcrito como mensaje del usuario
      this._sendJson(ws, { type: 'chat:transcription', text: text.trim() });

      // Procesar como mensaje normal
      await this._sendToAI(ws, sessionId, state, text.trim());
    } catch (err) {
      this.logger.error('[WebChannel] Transcription error:', err.message);
      this._sendJson(ws, { type: 'chat_error', error: 'Error transcribiendo audio.' });
      state.processing = false;
    }
  }

  async _handleTTS(ws, text) {
    if (!text || !this.tts || !this.tts.isEnabled()) {
      this._sendJson(ws, { type: 'chat:tts_error', error: 'TTS no disponible.' });
      return;
    }

    try {
      this._sendJson(ws, { type: 'chat:status', status: 'synthesizing' });
      const audioBuffer = await this.tts.synthesize(text);
      if (!audioBuffer) {
        this._sendJson(ws, { type: 'chat:tts_error', error: 'TTS no generó audio.' });
        return;
      }
      const base64 = audioBuffer.toString('base64');
      this._sendJson(ws, { type: 'chat:tts_audio', data: base64, mimeType: 'audio/wav' });
    } catch (err) {
      this.logger.error('[WebChannel] TTS error:', err.message);
      this._sendJson(ws, { type: 'chat:tts_error', error: 'Error generando audio.' });
    }
  }

  // ── Historial ─────────────────────────────────────────────────────────────

  _sendHistory(ws, state) {
    if (state.history.length === 0) return;
    this._sendJson(ws, {
      type: 'history_restore',
      messages: state.history.map(m => ({ role: m.role, content: m.content })),
    });
  }

  _cleanupParked() {
    const now = Date.now();
    for (const [id, entry] of this._parked) {
      if (now - entry.parkedAt > PARK_TTL_MS) {
        this._parked.delete(id);
        this.logger.info(`[WebChannel] Sesión parked ${id.slice(0, 8)} expirada, eliminada`);
      }
    }
    // Limpiar mensajes de sesiones inactivas > 7 días
    try { this.messagesRepo?.cleanup(); } catch {}
  }

  // ── BaseChannel interface ──────────────────────────────────────────────────

  async send(destination, text) {
    return this.sendText(destination, text);
  }

  async sendText(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._sendJson(session.ws, { type: 'chat:message', text });
  }

  async sendWithButtons(sessionId, text, buttons) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._sendJson(session.ws, { type: 'chat:message', text, buttons });
  }

  async sendPhoto(sessionId, base64Data, { caption, filename, mimeType } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const msgId = crypto.randomUUID().slice(0, 8);
    this._sendJson(session.ws, {
      type: 'chat:photo',
      msgId,
      data: base64Data,
      mimeType: mimeType || 'image/png',
      caption,
      filename,
    });
    return msgId;
  }

  async sendDocument(sessionId, base64Data, { caption, filename, mimeType } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const msgId = crypto.randomUUID().slice(0, 8);
    this._sendJson(session.ws, {
      type: 'chat:document',
      msgId,
      data: base64Data,
      mimeType: mimeType || 'application/octet-stream',
      caption,
      filename,
    });
    return msgId;
  }

  async editMessage(sessionId, msgId, text) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._sendJson(session.ws, { type: 'chat:edit', msgId, text });
  }

  async sendVoice(sessionId, base64Data, { caption, filename, mimeType } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const msgId = crypto.randomUUID().slice(0, 8);
    this._sendJson(session.ws, {
      type: 'chat:voice',
      msgId,
      data: base64Data,
      mimeType: mimeType || 'audio/ogg',
      caption,
      filename,
    });
    return msgId;
  }

  async sendVideo(sessionId, base64Data, { caption, filename, mimeType } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const msgId = crypto.randomUUID().slice(0, 8);
    this._sendJson(session.ws, {
      type: 'chat:video',
      msgId,
      data: base64Data,
      mimeType: mimeType || 'video/mp4',
      caption,
      filename,
    });
    return msgId;
  }

  async deleteMessage(sessionId, msgId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._sendJson(session.ws, { type: 'chat:delete', msgId });
  }

  /**
   * Envía texto a una sesión web. Retorna true si se envió, false si no disponible.
   */
  sendToSession(sessionId, text) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ws) return false;
    try {
      this._sendJson(session.ws, { type: 'chat_chunk', text });
      this._sendJson(session.ws, { type: 'chat_done', text });
      return true;
    } catch {
      return false;
    }
  }

  listSessions() {
    return [...this.sessions.entries()].map(([id, s]) => ({
      sessionId: id,
      provider: s.state.provider,
      agent: s.state.agent,
      messages: s.state.history.length,
      cwd: s.state.cwd,
    }));
  }

  async sendTyping(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this._sendJson(session.ws, { type: 'chat:typing' });
  }

  toJSON() {
    return {
      type: 'web',
      activeSessions: this.sessions.size,
      parkedSessions: this._parked.size,
      sessions: [...this.sessions.entries()].map(([id, s]) => ({
        id: id.slice(0, 8),
        provider: s.state.provider,
        agent: s.state.agent,
        messages: s.state.history.length,
      })),
    };
  }

  // ── Comandos ───────────────────────────────────────────────────────────────

  _handleCommand(ws, sessionId, state, text) {
    const parts = text.split(/\s+/);
    const cmd   = parts[0].toLowerCase();
    const arg   = parts.slice(1).join(' ').trim();

    switch (cmd) {
      case '/provider': {
        if (!arg) {
          const list = this.providers.list().map(p =>
            `${p.name === state.provider ? '→ ' : '  '}${p.name} (${p.label})`
          ).join('\n');
          this._sendJson(ws, { type: 'command_result', text: `Providers disponibles:\n${list}` });
          return;
        }
        const p = this.providers.get(arg);
        if (!p) {
          this._sendJson(ws, { type: 'command_result', text: `Provider "${arg}" no encontrado.` });
          return;
        }
        state.provider = arg;
        state.history = [];
        try { this.messagesRepo?.clear(sessionId); } catch {}
        this._saveSettings(sessionId, state);
        this._sendJson(ws, { type: 'command_result', text: `Provider cambiado a ${p.label || arg}`, provider: arg });
        return;
      }

      case '/agente': {
        if (!arg) {
          const list = this.agents.list().map(a =>
            `${a.key === state.agent ? '→ ' : '  '}${a.key}: ${a.description || ''}`
          ).join('\n');
          this._sendJson(ws, { type: 'command_result', text: list || 'No hay agentes configurados.', agent: state.agent });
          return;
        }
        if (arg === 'ninguno' || arg === 'none') {
          state.agent = null;
          this._sendJson(ws, { type: 'command_result', text: 'Agente desactivado.', agent: null });
          return;
        }
        const a = this.agents.get(arg);
        if (!a) {
          this._sendJson(ws, { type: 'command_result', text: `Agente "${arg}" no encontrado.` });
          return;
        }
        state.agent = arg;
        this._sendJson(ws, { type: 'command_result', text: `Agente activo: ${arg}`, agent: arg });
        return;
      }

      case '/modelo':
      case '/model': {
        if (!arg) {
          this._sendJson(ws, { type: 'command_result', text: `Modelo actual: ${state.model || '(default del provider)'}` });
          return;
        }
        state.model = arg;
        this._sendJson(ws, { type: 'command_result', text: `Modelo: ${arg}` });
        return;
      }

      case '/cd': {
        if (!arg) {
          this._sendJson(ws, { type: 'command_result', text: `Directorio actual: ${state.cwd}`, cwd: state.cwd });
          return;
        }
        const expanded = arg === '~' ? process.env.HOME
          : arg.startsWith('~/') ? path.join(process.env.HOME, arg.slice(2))
          : arg;
        const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(state.cwd, expanded);
        try {
          const stat = fs.statSync(resolved);
          if (!stat.isDirectory()) {
            this._sendJson(ws, { type: 'command_result', text: `"${resolved}" no es un directorio.` });
            return;
          }
          state.cwd = resolved;
          this._saveSettings(sessionId, state);
          this._sendJson(ws, { type: 'command_result', text: `Directorio: ${resolved}`, cwd: resolved });
        } catch {
          this._sendJson(ws, { type: 'command_result', text: `Directorio no encontrado: ${resolved}` });
        }
        return;
      }

      case '/nueva':
      case '/reset':
      case '/clear': {
        state.history = [];
        state.claudeSession = null;
        try { this.messagesRepo?.clear(sessionId); } catch {}
        this._sendJson(ws, { type: 'command_result', text: 'Conversación reiniciada.' });
        return;
      }

      case '/modo':
      case '/mode': {
        const modes = ['ask', 'auto', 'plan'];
        if (!arg || !modes.includes(arg)) {
          this._sendJson(ws, { type: 'command_result', text: `Modo actual: ${state.claudeMode}. Opciones: ${modes.join(', ')}` });
          return;
        }
        state.claudeMode = arg;
        this._saveSettings(sessionId, state);
        this._sendJson(ws, { type: 'command_result', text: `Modo: ${arg}` });
        return;
      }

      case '/estado':
      case '/status': {
        const info = [
          `Provider: ${state.provider}`,
          `Agente: ${state.agent || '(ninguno)'}`,
          `Modelo: ${state.model || '(default)'}`,
          `Modo: ${state.claudeMode}`,
          `Directorio: ${state.cwd}`,
          `Historial: ${state.history.length} mensajes`,
        ].join('\n');
        this._sendJson(ws, { type: 'command_result', text: info });
        return;
      }

      case '/ayuda':
      case '/help': {
        const help = [
          '/provider [nombre] — cambiar provider de IA',
          '/agente [nombre] — seleccionar agente',
          '/modelo [nombre] — cambiar modelo',
          '/cd [ruta] — cambiar directorio',
          '/nueva — nueva conversación',
          '/modo [ask|auto|plan] — modo de permisos (Claude Code)',
          '/estado — ver estado actual',
          '/ayuda — esta ayuda',
        ].join('\n');
        this._sendJson(ws, { type: 'command_result', text: help });
        return;
      }

      case '/test-buttons': {
        this._sendJson(ws, {
          type: 'chat:message',
          text: '¿Qué querés hacer?',
          buttons: [
            { text: '📋 Ver estado', callback_data: '/estado' },
            { text: '🆕 Nueva conversación', callback_data: '/nueva' },
            { text: '❓ Ayuda', callback_data: '/ayuda' },
          ],
        });
        return;
      }

      default:
        this._sendJson(ws, { type: 'command_result', text: `Comando desconocido: ${cmd}. Usá /ayuda.` });
    }
  }

  // ── IA ─────────────────────────────────────────────────────────────────────

  async _sendToAI(ws, sessionId, state, text, images = null, files = null) {
    state.processing = true;

    try {
      if (!this.convSvc) {
        this._sendJson(ws, { type: 'chat_error', error: 'ConversationService no disponible.' });
        state.processing = false;
        return;
      }

      const mode = state.claudeMode || 'auto';
      const isMcpMode = mode === 'auto';

      const onChunk = isMcpMode ? null : (partial) => {
        this._sendJson(ws, { type: 'chat_chunk', text: partial });
      };

      const onStatus = isMcpMode ? (status, detail) => {
        this._sendJson(ws, { type: 'chat_status', status, detail });
      } : null;

      // Callback de aprobación para modo ask (providers API)
      const dynamicRegistry = require('../telegram/DynamicCallbackRegistry');
      const onAskPermission = mode === 'ask' && state.provider !== 'claude-code'
        ? async (toolName, toolArgs) => {
            return new Promise((resolve) => {
              const ts = Date.now();
              const approveId = `ask:${ts}:y`;
              const rejectId  = `ask:${ts}:n`;
              const timeout = setTimeout(() => {
                dynamicRegistry.remove(approveId);
                dynamicRegistry.remove(rejectId);
                resolve(false);
              }, 60000);
              dynamicRegistry.register(approveId, {
                type: 'func', fn: () => { clearTimeout(timeout); resolve(true); },
                once: true, ttl: 60000,
              });
              dynamicRegistry.register(rejectId, {
                type: 'func', fn: () => { clearTimeout(timeout); resolve(false); },
                once: true, ttl: 60000,
              });
              const preview = JSON.stringify(toolArgs || {}).slice(0, 300);
              this._sendJson(ws, {
                type: 'chat_ask_permission',
                tool: toolName,
                args: preview,
                approveId,
                rejectId,
              });
            });
          }
        : null;

      const result = await this.convSvc.processMessage({
        chatId: sessionId,
        agentKey: state.agent || (this._scheduler && this._scheduler.getDefaultAgent()) || null,
        provider: state.provider,
        model: state.model,
        text,
        images,
        files,
        history: state.history,
        claudeSession: state.claudeSession,
        claudeMode: state.claudeMode,
        onChunk,
        onStatus,
        onAskPermission,
        shellId: sessionId,
        botKey: WebChannel.BOT_KEY,
        channel: 'web',
        userId: state.userId || null,
      });

      if (result.history) state.history = result.history;
      if (result.newSession) state.claudeSession = result.newSession;

      if (!result.history) {
        state.history.push({ role: 'user', content: text });
        state.history.push({ role: 'assistant', content: result.text });
      }

      // Persistir mensajes en SQLite
      try {
        this.messagesRepo?.pushPair(sessionId, text, result.text);
      } catch (err) {
        this.logger.error('[WebChannel] Error persistiendo mensajes:', err.message);
      }

      // Filtrar texto meta/noise de la IA
      if (isNoiseText(result.text)) {
        this._sendJson(ws, { type: 'chat_done', text: '' });
        this._saveSettings(sessionId, state);
        return;
      }

      // Parsear botones inline del AI response
      const { text: cleanText, buttons } = parseButtons(result.text);
      if (buttons) {
        // Aplanar filas a array simple para el cliente web
        const flatButtons = buttons.flat();
        this._sendJson(ws, { type: 'chat_done', text: cleanText, buttons: flatButtons });
      } else {
        this._sendJson(ws, { type: 'chat_done', text: cleanText });
      }
      this._saveSettings(sessionId, state);

      if (result.savedMemoryFiles?.length > 0) {
        this._sendJson(ws, { type: 'command_result', text: `Memoria guardada: ${result.savedMemoryFiles.join(', ')}` });
      }
    } catch (err) {
      this.logger.error('[WebChannel] Error:', err.stack || err.message);
      this._sendJson(ws, { type: 'chat_error', error: err.message || 'Error procesando mensaje' });
    }

    state.processing = false;
  }

  // ── Dynamic Callbacks ────────────────────────────────────────────────────

  async _executeDynamicCallback(ws, sessionId, state, cb) {
    const { exec } = require('child_process');

    switch (cb.type) {
      case 'message':
        this._sendJson(ws, { type: 'chat:message', text: cb.text || '(vacío)' });
        break;

      case 'command': {
        const timeout = cb.timeout || 15000;
        this._sendJson(ws, { type: 'chat:status', status: 'running_command' });
        try {
          const output = await new Promise((resolve, reject) => {
            exec(cb.cmd, { timeout, cwd: state.cwd }, (err, stdout, stderr) => {
              if (err && !stdout && !stderr) return reject(err);
              resolve((stdout || '') + (stderr || ''));
            });
          });
          this._sendJson(ws, { type: 'chat:message', text: `\`\`\`\n${output.trim() || '(sin output)'}\n\`\`\`` });
        } catch (err) {
          this._sendJson(ws, { type: 'chat:message', text: `Error: ${err.message}` });
        }
        break;
      }

      case 'prompt':
        if (!state.processing) {
          await this._sendToAI(ws, sessionId, state, cb.text);
        }
        break;

      case 'func':
        if (typeof cb.fn === 'function') cb.fn();
        break;

      default:
        this._sendJson(ws, { type: 'chat:message', text: `Callback tipo "${cb.type}" no soportado.` });
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _sendStatus(ws, state) {
    this._sendJson(ws, {
      type: 'status',
      provider: state.provider,
      agent: state.agent,
      cwd: state.cwd,
    });
  }

  _sendJson(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  _saveSettings(sessionId, state) {
    if (!this.chatSettingsRepo) return;
    try {
      this.chatSettingsRepo.save(WebChannel.BOT_KEY, sessionId, {
        provider: state.provider,
        model: state.model,
        cwd: state.cwd,
      });
      if (state.claudeMode) {
        this.chatSettingsRepo.saveMode(WebChannel.BOT_KEY, sessionId, state.claudeMode);
      }
      // claudeSession puede ser un objeto ClaudePrintSession o un string ID
      const csId = state.claudeSession?.claudeSessionId || (typeof state.claudeSession === 'string' ? state.claudeSession : null);
      const msgCount = state.claudeSession?.messageCount || state.history.length;
      if (csId) {
        this.chatSettingsRepo.saveSession(WebChannel.BOT_KEY, sessionId, {
          claudeSessionId: csId,
          messageCount: msgCount,
          cwd: state.claudeSession?.cwd || state.cwd,
        });
      }
    } catch (err) {
      this.logger.error('[WebChannel] Error guardando settings:', err.message);
    }
  }
}

module.exports = WebChannel;
