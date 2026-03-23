'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const BaseChannel    = require('../BaseChannel');
const parseButtons   = require('../parseButtons');

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
  constructor({ convSvc, providers, providerConfig, agents, chatSettingsRepo, messagesRepo, eventBus, logger, transcriber, tts } = {}) {
    super({ eventBus, logger });
    this.convSvc          = convSvc;
    this.providers        = providers;
    this.providerConfig   = providerConfig;
    this.agents           = agents;
    this.chatSettingsRepo = chatSettingsRepo;
    this.messagesRepo     = messagesRepo;
    this.transcriber      = transcriber;
    this.tts              = tts;
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

    const sessionId = opts.sessionId || crypto.randomUUID();
    this._sendJson(ws, { type: 'session_id', id: sessionId });

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

    const state = {
      provider: saved?.provider || opts.provider || this.providerConfig?.getConfig()?.default || 'anthropic',
      agent: opts.agent || null,
      model: saved?.model || null,
      history: savedMessages,
      claudeSession: saved?.claude_session_id || null,
      claudeMode: saved?.claude_mode || 'auto',
      cwd: saved?.cwd || process.env.HOME || '~',
      processing: false,
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
        const resolved = path.resolve(state.cwd, arg);
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

      const onChunk = (partial) => {
        this._sendJson(ws, { type: 'chat_chunk', text: partial });
      };

      const result = await this.convSvc.processMessage({
        chatId: sessionId,
        agentKey: state.agent,
        provider: state.provider,
        model: state.model,
        text,
        images,
        files,
        history: state.history,
        claudeSession: state.claudeSession,
        claudeMode: state.claudeMode,
        onChunk,
        shellId: sessionId,
        botKey: WebChannel.BOT_KEY,
        channel: 'web',
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
