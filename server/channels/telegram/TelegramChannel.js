'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const BaseChannel          = require('../BaseChannel');
const ClaudePrintSession   = require('../../core/ClaudePrintSession');
const ConsoleSession       = require('../../core/ConsoleSession');
const CommandHandler       = require('./CommandHandler');
const CallbackHandler      = require('./CallbackHandler');
const PendingActionHandler = require('./PendingActionHandler');
const MediaHandler         = require('./MediaHandler');
const ResponseRenderer     = require('./ResponseRenderer');
const MessageProcessor     = require('./MessageProcessor');
const parseButtons         = require('../parseButtons');

const { httpsPost, httpsPostMultipart, cleanPtyOutput, stripAnsi, chunkText, tdbg } = require('./utils');

const POLL_TIMEOUT  = 25;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// ── TelegramBot (instancia por bot) ──────────────────────────────────────────

class TelegramBot {
  constructor(key, token, {
    initialOffset = 0,
    onOffsetSave  = null,
    commandHandler      = null,
    callbackHandler     = null,
    pendingHandler      = null,
    mediaHandler        = null,
    responseRenderer    = null,
    messageProcessor    = null,
    convSvc             = null,
    sessionManager      = null,
    agents              = null,
    memory              = null,
    consolidator        = null,
    providers           = null,
    providerConfig      = null,
    chatSettings        = null,
    events              = null,
    transcriber         = null,
    tts                 = null,
    logger              = console,
  } = {}) {
    this.key   = key;
    this.token = token;
    this.running = false;
    this.offset  = initialOffset;
    this._onOffsetSave = onOffsetSave || (() => {});

    this.botInfo          = null;
    this.defaultAgent     = 'claude';
    this.whitelist        = [];
    this.groupWhitelist   = [];
    this.rateLimit        = 30;
    this.rateLimitKeyword = '';
    this.startGreeting    = true;
    this.lastGreetingAt   = 0;
    this.rateCounts       = new Map();
    /** @type {Map<number, object>} */
    this.chats            = new Map();

    // Handlers extraídos
    this._commandHandler    = commandHandler;
    this._callbackHandler   = callbackHandler;
    this._pendingHandler    = pendingHandler;
    this._mediaHandler      = mediaHandler;
    this._responseRenderer  = responseRenderer || new ResponseRenderer();
    this._messageProcessor  = messageProcessor;

    // Deps directas (usadas por métodos que quedan en TelegramBot)
    this._convSvc         = convSvc;
    this._sessionManager  = sessionManager;
    this._agents          = agents;
    this._memory          = memory;
    this._consolidator    = consolidator;
    this._providers       = providers;
    this._providerConfig  = providerConfig;
    this._chatSettings    = chatSettings;
    this._events          = events;
    this._transcriber     = transcriber;
    this._tts             = tts;
    this._logger          = logger;
  }

  // ── Configuración ────────────────────────────────────────────────────────

  setDefaultAgent(agentKey) { this.defaultAgent = agentKey; }
  setWhitelist(ids)         { this.whitelist = ids.map(Number).filter(Boolean); }
  setGroupWhitelist(ids)    { this.groupWhitelist = ids.map(Number).filter(Boolean); }
  setRateLimit(n)           { this.rateLimit = Math.max(0, parseInt(n, 10) || 0); }
  setRateLimitKeyword(kw)   { this.rateLimitKeyword = (kw || '').trim(); }

  addToWhitelist(chatId) {
    const id = Number(chatId);
    if (!id || this.whitelist.includes(id)) return false;
    this.whitelist.push(id);
    return true;
  }
  removeFromWhitelist(chatId) {
    const id  = Number(chatId);
    const idx = this.whitelist.indexOf(id);
    if (idx === -1) return false;
    this.whitelist.splice(idx, 1);
    return true;
  }
  addToGroupWhitelist(groupId) {
    const id = Number(groupId);
    if (!id || this.groupWhitelist.includes(id)) return false;
    this.groupWhitelist.push(id);
    return true;
  }
  removeFromGroupWhitelist(groupId) {
    const id  = Number(groupId);
    const idx = this.groupWhitelist.indexOf(id);
    if (idx === -1) return false;
    this.groupWhitelist.splice(idx, 1);
    return true;
  }

  // ── Checks ───────────────────────────────────────────────────────────────

  _isGroup(chatType) {
    return chatType === 'group' || chatType === 'supergroup';
  }
  _isAllowed(chatId, chatType) {
    if (this._isGroup(chatType)) {
      if (this.groupWhitelist.length === 0) return true;
      return this.groupWhitelist.includes(chatId);
    }
    if (this.whitelist.length === 0) return true;
    return this.whitelist.includes(chatId);
  }
  _isMentionedOrReply(msg) {
    if (!this.botInfo) return false;
    if (msg.reply_to_message && msg.reply_to_message.from?.id === this.botInfo.id) return true;
    const text = msg.text || msg.caption || '';
    if (text.includes(`@${this.botInfo.username}`)) return true;
    if (text.startsWith('/')) return true;
    return false;
  }
  _checkRateLimit(chatId) {
    if (this.rateLimit === 0) return true;
    const now = Date.now();
    let entry = this.rateCounts.get(chatId);
    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      this.rateCounts.set(chatId, entry);
    }
    if (entry.count >= this.rateLimit) return false;
    entry.count++;
    return true;
  }
  _isClaudeBased(agentKeyOrProvider = this.defaultAgent) {
    if (agentKeyOrProvider === 'claude' || agentKeyOrProvider === 'claude-code') return true;
    const def = this._agents ? this._agents.get(agentKeyOrProvider) : null;
    return !!(def && def.command && def.command.includes('claude'));
  }

  _claudeSessionOpts(chat) {
    return {
      model: chat.claudeSession?.model || null,
      permissionMode: chat.claudeMode || 'auto',
      cwd: chat.monitorCwd || process.env.HOME,
    };
  }

  // ── Telegram API ─────────────────────────────────────────────────────────

  async _apiCall(method, body = {}) {
    const urlPath = `/bot${this.token}/${method}`;
    const data = await httpsPost(urlPath, body);
    if (!data.ok) throw new Error(data.description || `Telegram error: ${method}`);
    return data.result;
  }
  async _getUpdates() {
    const urlPath = `/bot${this.token}/getUpdates`;
    const data = await httpsPost(urlPath, {
      offset: this.offset,
      timeout: POLL_TIMEOUT,
      allowed_updates: ['message', 'callback_query'],
    }, (POLL_TIMEOUT + 10) * 1000);
    if (!data.ok) throw new Error(data.description || 'getUpdates error');
    return data.result;
  }
  async _answerCallback(id, text = '') {
    try { await this._apiCall('answerCallbackQuery', { callback_query_id: id, text }); } catch {}
  }

  async sendPhoto(chatId, photoBuffer, opts = {}) {
    const urlPath = `/bot${this.token}/sendPhoto`;
    const fields = { chat_id: String(chatId) };
    if (opts.caption) fields.caption = opts.caption;
    if (opts.parse_mode) fields.parse_mode = opts.parse_mode;
    const file = {
      fieldName: 'photo',
      filename: opts.filename || 'photo.png',
      contentType: opts.contentType || 'image/png',
      buffer: photoBuffer,
    };
    const data = await httpsPostMultipart(urlPath, fields, file);
    if (!data.ok) throw new Error(data.description || 'sendPhoto error');
    return data.result;
  }

  async sendDocument(chatId, docBuffer, opts = {}) {
    const urlPath = `/bot${this.token}/sendDocument`;
    const fields = { chat_id: String(chatId) };
    if (opts.caption) fields.caption = opts.caption;
    if (opts.parse_mode) fields.parse_mode = opts.parse_mode;
    const file = {
      fieldName: 'document',
      filename: opts.filename || 'file.bin',
      contentType: opts.contentType || 'application/octet-stream',
      buffer: docBuffer,
    };
    const data = await httpsPostMultipart(urlPath, fields, file);
    if (!data.ok) throw new Error(data.description || 'sendDocument error');
    return data.result;
  }

  // ── Start / Stop / Poll ──────────────────────────────────────────────────

  async start() {
    if (this.running) return { username: this.botInfo?.username };
    this.running = true;

    try { await this._apiCall('deleteWebhook', { drop_pending_updates: false }); }
    catch (e) { console.error(`[Telegram] deleteWebhook falló: ${e.message}`); }

    const me = await this._apiCall('getMe');
    this.botInfo = { id: me.id, username: me.username, firstName: me.first_name };

    try {
      await this._apiCall('setMyCommands', {
        commands: [
          { command: 'nueva',        description: 'Nueva conversación' },
          { command: 'modelo',       description: 'Ver o cambiar modelo' },
          { command: 'modo',         description: 'Modo: auto/ask/plan' },
          { command: 'costo',        description: 'Costo de la sesión' },
          { command: 'estado',       description: 'Estado detallado' },
          { command: 'agentes',      description: 'Listar agentes' },
          { command: 'skills',       description: 'Skills instalados' },
          { command: 'consola',      description: 'Modo consola bash' },
          { command: 'whisper',      description: 'Ver/cambiar modelo Whisper' },
          { command: 'tts',          description: 'Ver/configurar text-to-speech' },
          { command: 'recordar',     description: 'Crear recordatorio' },
          { command: 'restart',      description: 'Reiniciar servidor PM2' },
          { command: 'run',          description: 'Ejecutar comando en terminal' },
          { command: 'ayuda',        description: 'Todos los comandos' },
        ],
      });
    } catch (e) { console.error(`[Telegram] setMyCommands falló: ${e.message}`); }

    this._poll();

    if (this._events) {
      this._events.on('memory:topic-suggestion', ({ agentKey, chatId, topicName }) => {
        if (!chatId) return;
        const displayName = topicName.replace(/_/g, ' ');
        this.sendWithButtons(
          parseInt(chatId, 10) || chatId,
          `💡 *Nuevo tópico detectado*\n\n` +
          `El consolidador encontró un tema recurrente: *${displayName}*\n\n` +
          `¿Querés agregarlo a las preferencias de memoria de \`${agentKey}\`?\n` +
          `_Si aceptás, futuras conversaciones sobre este tema se consolidarán automáticamente._`,
          [[
            { text: '✅ Sí, agregar', callback_data: `topic:add:${topicName}:${agentKey}` },
            { text: '❌ No, ignorar', callback_data: `topic:skip:${topicName}` },
          ]]
        ).catch(() => {});
      });
    }

    console.log(`[Telegram] Bot "${this.key}" iniciado: @${me.username}`);

    const GREETING_COOLDOWN = 5 * 60 * 1000;
    if (this.startGreeting && this.whitelist.length > 0 &&
        Date.now() - this.lastGreetingAt > GREETING_COOLDOWN) {
      this.lastGreetingAt = Date.now();
      this._onOffsetSave();
      const greetings = [
        '👋 Hola, estaba arreglando unas cosas. ¡Ya podemos conversar!',
        '🔧 Estuve haciendo unos ajustes. ¡Ya estoy de vuelta!',
        '⚡ De vuelta en línea. ¡Listo para conversar!',
        '🛠️ Terminé con las actualizaciones. ¡Aquí estoy!',
      ];
      const msg = greetings[Math.floor(Math.random() * greetings.length)];
      for (const chatId of this.whitelist) {
        this.sendText(chatId, msg).catch(() => {});
      }
    }

    return { username: me.username };
  }

  async stop() {
    this.running = false;
    console.log(`[Telegram] Bot "${this.key}" detenido`);
  }

  async _poll() {
    while (this.running) {
      try {
        const updates = await this._getUpdates();

        if (updates.length > 0) {
          // Actualizar offset al último update recibido
          this.offset = updates[updates.length - 1].update_id + 1;

          // Agrupar updates por chatId: paralelo entre chats, serial dentro del mismo chat
          const byChat = new Map();
          for (const u of updates) {
            const chatId = u.message?.chat?.id || u.callback_query?.message?.chat?.id || 'unknown';
            if (!byChat.has(chatId)) byChat.set(chatId, []);
            byChat.get(chatId).push(u);
          }

          const results = await Promise.allSettled(
            [...byChat.values()].map(async (chatUpdates) => {
              for (const u of chatUpdates) {
                try { await this._handleUpdate(u); } catch (err) {
                  console.error(`[Telegram:${this.key}] Error en update:`, err.message);
                }
              }
            })
          );

          for (const r of results) {
            if (r.status === 'rejected') {
              console.error(`[Telegram:${this.key}] Error en batch de chat:`, r.reason?.message);
            }
          }

          if (this._onOffsetSave) this._onOffsetSave();
        }
      } catch (err) {
        if (!this.running) break;
        console.error(`[Telegram:${this.key}] Error en polling:`, err.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  // ── Handlers de updates ──────────────────────────────────────────────────

  async _handleUpdate(update) {
    if (update.callback_query) {
      await this._handleCallbackQuery(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg) return;
    const isGroup = this._isGroup(msg.chat.type);
    if (isGroup && !this._isMentionedOrReply(msg)) return;
    if (msg.voice || msg.audio) {
      if (this._mediaHandler) {
        await this._mediaHandler.handleVoice(this, msg);
      }
      return;
    }
    if (msg.photo) {
      if (this._mediaHandler) {
        await this._mediaHandler.handlePhoto(this, msg);
      }
      return;
    }
    if (!msg.text) return;
    await this._handleMessage(msg);
  }

  async _handleMessage(msg) {
    // Deduplicar por message_id
    if (!this._seenMsgIds) this._seenMsgIds = new Set();
    if (this._seenMsgIds.has(msg.message_id)) {
      tdbg('dedup', `SKIP msg_id=${msg.message_id} (duplicado por id)`);
      return;
    }
    this._seenMsgIds.add(msg.message_id);
    if (this._seenMsgIds.size > 200) {
      const arr = [...this._seenMsgIds];
      this._seenMsgIds = new Set(arr.slice(-100));
    }

    // Deduplicar por contenido+chat
    if (!this._lastMsgByChat) this._lastMsgByChat = new Map();
    const dedupKey = `${msg.chat.id}:${(msg.text || '').trim()}`;
    const lastTs   = this._lastMsgByChat.get(dedupKey) || 0;
    const now      = Date.now();
    if (now - lastTs < 2000) {
      tdbg('dedup', `SKIP "${(msg.text||'').slice(0,30)}" (mismo texto en ${now - lastTs}ms)`);
      return;
    }
    this._lastMsgByChat.set(dedupKey, now);
    if (this._lastMsgByChat.size > 500) {
      for (const [k, v] of this._lastMsgByChat) {
        if (now - v > 10000) this._lastMsgByChat.delete(k);
      }
    }

    const chatId  = msg.chat.id;
    const isGroup = this._isGroup(msg.chat.type);
    const replyTo = isGroup ? msg.message_id : undefined;
    let text = msg.text.trim();

    if (isGroup && this.botInfo?.username) {
      text = text.replace(new RegExp(`@${this.botInfo.username}\\b`, 'gi'), '').trim();
    }

    if (text === '/id') {
      const idMsg = isGroup
        ? `🪪 Chat ID del grupo: \`${chatId}\`\nTu user ID: \`${msg.from.id}\``
        : `🪪 Tu chat ID es: \`${chatId}\``;
      await this.sendText(chatId, idMsg, replyTo);
      return;
    }

    if (!this._isAllowed(chatId, msg.chat.type)) {
      await this.sendText(chatId, '⛔ No tenés acceso a este bot.', replyTo);
      return;
    }

    let chat = this.chats.get(chatId);
    if (!chat) {
      const saved = this._chatSettings ? this._chatSettings.load(this.key, chatId) : null;

      let restoredSession = null;
      if (saved?.claude_session_id && saved.message_count > 0) {
        restoredSession = new ClaudePrintSession({
          claudeSessionId: saved.claude_session_id,
          messageCount:    saved.message_count,
          cwd:             saved.cwd || process.env.HOME,
          model:           saved.model || null,
          permissionMode:  saved.claude_mode || 'auto',
        });
        tdbg('init', `restored session ${saved.claude_session_id.slice(0,8)}… msgCount=${saved.message_count} cwd=${saved.cwd} mode=${saved.claude_mode || 'auto'}`);
      }

      chat = {
        chatId,
        username:       msg.from?.username || null,
        firstName:      msg.from?.first_name || 'Usuario',
        sessionId:      null,
        claudeSession:  restoredSession,
        activeAgent:    null,
        pendingAction:  null,
        lastMessageAt:  Date.now(),
        lastPreview:    '',
        rateLimited:    false,
        rateLimitedUntil: 0,
        monitorCwd:     saved?.cwd || process.env.HOME,
        busy:           false,
        provider:       saved?.provider || 'claude-code',
        model:          saved?.model    || 'sonnet',
        aiHistory:      (this._chatSettings?.loadHistory(this.key, chatId)) || [],
        claudeMode:     saved?.claude_mode || 'auto',
        consoleMode:    false,
        lastButtonsMsgId: null,
      };
      this.chats.set(chatId, chat);
    }

    if (chat.rateLimited) {
      if (Date.now() >= chat.rateLimitedUntil) {
        chat.rateLimited = false;
        this.rateCounts.delete(chatId);
      } else if (this.rateLimitKeyword && text === this.rateLimitKeyword) {
        this.rateCounts.delete(chatId);
        chat.rateLimited = false;
        await this.sendText(chatId, '✅ Límite reseteado. Podés seguir hablando.');
        return;
      } else {
        return;
      }
    }

    if (!this._checkRateLimit(chatId)) {
      chat.rateLimited = true;
      const entry = this.rateCounts.get(chatId);
      chat.rateLimitedUntil = entry
        ? entry.windowStart + RATE_WINDOW_MS
        : Date.now() + RATE_WINDOW_MS;
      const kwHint = this.rateLimitKeyword
        ? ` Enviá \`${this.rateLimitKeyword}\` para continuar antes de que expire.`
        : '';
      await this.sendText(chatId, `⏳ Límite alcanzado (${this.rateLimit} msg/hora).${kwHint}`);
      return;
    }

    console.log(`[Telegram:${this.key}] Mensaje de ${chatId}: ${text.slice(0, 60)}`);
    chat.lastMessageAt = Date.now();
    chat.lastPreview   = text.slice(0, 60);

    if (chat.consoleMode && !text.startsWith('/')) {
      return await this._handleConsoleInput(chatId, text, chat);
    }

    if (chat.pendingAction && !text.startsWith('/')) {
      if (this._pendingHandler) {
        return await this._pendingHandler.handle(this, msg, text, chat);
      }
      return;
    }

    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmd   = parts[0].toLowerCase();
      const args  = parts.slice(1);
      await this._handleCommand(msg, cmd, args, chat);
    } else {
      await this._sendToSession(chatId, text, chat, msg._images, msg._statusMsg);
    }
  }

  async _handleCommand(msg, cmd, args, chat) {
    if (this._commandHandler) {
      return await this._commandHandler.handle(this, msg, cmd, args, chat);
    }
    await this.sendText(msg.chat.id, `❓ Comando desconocido: /${cmd}`);
  }

  async _handleCallbackQuery(cbq) {
    if (this._callbackHandler) {
      return await this._callbackHandler.handle(this, cbq);
    }
  }

  // ── Delegación a módulos extraídos ──────────────────────────────────────

  async _sendToSession(chatId, text, chat, images, existingStatusMsg) {
    if (this._messageProcessor) {
      return await this._messageProcessor.process(this, chatId, text, chat, images, existingStatusMsg);
    }
    console.error(`[Telegram:${this.key}] MessageProcessor no disponible`);
  }

  // ── Sesiones PTY ─────────────────────────────────────────────────────────

  async getOrCreateSession(chatId, chat, forceNew = false, agentKeyOverride = null) {
    if (!this._sessionManager) return null;
    if (!forceNew && chat.sessionId) {
      const existing = this._sessionManager.get(chat.sessionId);
      if (existing && existing.active) return existing;
    }
    const agentKey = agentKeyOverride || this.defaultAgent;
    const agent    = this._agents ? this._agents.get(agentKey) : null;
    const command  = agent ? agent.command : agentKey === 'bash' ? null : agentKey;
    const session  = this._sessionManager.create({ type: 'pty', command, cols: 80, rows: 24, cwd: chat.monitorCwd || process.env.HOME });
    chat.sessionId = session.id;
    return session;
  }

  // ── Modo consola ─────────────────────────────────────────────────────────

  _getConsoleSession(chat) {
    if (!chat._consoleSession) {
      chat._consoleSession = new ConsoleSession(chat.monitorCwd);
    }
    return chat._consoleSession;
  }

  async _sendConsolePrompt(chatId, output, chat) {
    const session  = this._getConsoleSession(chat);
    const cwdShort = session.getCwdShort();
    const text     = `${output ? output + '\n\n' : ''}📁 \`${cwdShort}\``;
    const rawBtns  = session.getPromptButtons();
    const buttons  = rawBtns.map(row =>
      row.map(b => ({ text: b.text, callback_data: `console:${b.command}` }))
    );
    await this.sendWithButtons(chatId, text.slice(0, 4090), buttons);
  }

  async _handleConsoleInput(chatId, command, chat) {
    const trimmed = (command || '').trim();
    if (!trimmed) return;

    const session = this._getConsoleSession(chat);

    if (session.isExitCommand(trimmed)) {
      chat.consoleMode = false;
      chat._consoleSession = null;
      await this.sendWithButtons(chatId, '🖥️ Modo consola *desactivado*.',
        [[{ text: '🖥️ Monitor', callback_data: 'menu:monitor' },
          { text: '🤖 Menú',    callback_data: 'menu' }]]);
      return;
    }

    if (session.isCdCommand(trimmed)) {
      const target = trimmed.slice(2).trim();
      const result = session.changeDirectory(target);
      chat.monitorCwd = session.cwd;
      if (chat.claudeSession) chat.claudeSession.cwd = session.cwd;
      if (this._chatSettings) this._chatSettings.saveCwd(this.key, chatId, session.cwd);
      const msg = result.ok ? '' : `❌ cd: ${result.error}`;
      await this._sendConsolePrompt(chatId, msg, chat);
      return;
    }

    try {
      const { stdout, stderr, code } = await session.executeCommand(trimmed);
      const out = session.formatOutput(trimmed, stdout, stderr, code);
      await this._sendConsolePrompt(chatId, out, chat);
    } catch (err) {
      await this._sendConsolePrompt(chatId, `❌ Error: ${err.message}`, chat);
    }
  }

  // ── Envío de mensajes ─────────────────────────────────────────────────────

  async sendWithButtons(chatId, text, buttons, editMsgId = null) {
    const body = { chat_id: chatId, text: text.slice(0, 4096), parse_mode: 'Markdown',
                   reply_markup: { inline_keyboard: buttons } };

    const chat = this.chats.get(chatId);
    if (chat && chat.lastButtonsMsgId && !editMsgId) {
      try {
        await this._apiCall('editMessageText', {
          chat_id: chatId, message_id: chat.lastButtonsMsgId,
          text: '...', reply_markup: { inline_keyboard: [] },
        });
      } catch {}
    }

    if (editMsgId) {
      try {
        const result = await this._apiCall('editMessageText', { ...body, message_id: editMsgId });
        if (chat) chat.lastButtonsMsgId = editMsgId;
        return result;
      } catch (e) {
        if (e.message?.includes('not modified')) return;
        try {
          const result = await this._apiCall('editMessageText', { ...body, message_id: editMsgId, parse_mode: undefined });
          if (chat) chat.lastButtonsMsgId = editMsgId;
          return result;
        } catch (e2) { if (!e2.message?.includes('not modified')) console.error(`[Telegram] editMsg fallback FAIL: ${e2.message}`); }
      }
      return;
    }

    try {
      const result = await this._apiCall('sendMessage', body);
      if (chat && result?.message_id) chat.lastButtonsMsgId = result.message_id;
      return result;
    } catch {
      body.parse_mode = undefined;
      const result = await this._apiCall('sendMessage', body);
      if (chat && result?.message_id) chat.lastButtonsMsgId = result.message_id;
      return result;
    }
  }

  async sendText(chatId, text, replyToMessageId) {
    const chunks = chunkText(stripAnsi(text), 4096);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const body = { chat_id: chatId, text: chunk, parse_mode: 'Markdown' };
      if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
      try {
        await this._apiCall('sendMessage', body);
      } catch {
        try {
          delete body.parse_mode;
          await this._apiCall('sendMessage', body);
        } catch (e2) {
          console.error(`[Telegram:${this.key}] No se pudo enviar a ${chatId}:`, e2.message);
        }
      }
    }
  }

  async sendVoice(chatId, audioBuffer, replyToMessageId) {
    const urlPath = `/bot${this.token}/sendVoice`;
    const fields = { chat_id: String(chatId) };
    if (replyToMessageId) fields.reply_to_message_id = String(replyToMessageId);
    const data = await httpsPostMultipart(urlPath, fields, {
      fieldName: 'voice',
      buffer: audioBuffer,
      filename: 'tts.wav',
      contentType: 'audio/wav',
    });
    if (!data.ok) throw new Error(data.description || 'sendVoice error');
    return data.result;
  }

  async sendVideo(chatId, videoBuffer, opts = {}) {
    const urlPath = `/bot${this.token}/sendVideo`;
    const fields = { chat_id: String(chatId) };
    if (opts.caption) fields.caption = opts.caption;
    if (opts.parse_mode) fields.parse_mode = opts.parse_mode;
    const file = {
      fieldName: 'video',
      filename: opts.filename || 'video.mp4',
      contentType: opts.contentType || 'video/mp4',
      buffer: videoBuffer,
    };
    const data = await httpsPostMultipart(urlPath, fields, file);
    if (!data.ok) throw new Error(data.description || 'sendVideo error');
    return data.result;
  }

  // ── Menú ─────────────────────────────────────────────────────────────────

  async _sendMenu(chatId, editMsgId = null) {
    const chat = this.chats.get(chatId) || null;
    const def  = this._callbackHandler
      ? this._callbackHandler.getMenuDef('menu', { bot: this })
      : null;
    if (!def) return;
    const text    = typeof def.text    === 'function' ? def.text(chat)    : def.text;
    const rawRows = typeof def.buttons === 'function' ? def.buttons(chat) : def.buttons;
    const rows = (rawRows || []).map(row =>
      row.map(btn => ({ text: btn.text, callback_data: btn.id }))
    );
    await this.sendWithButtons(chatId, text, rows, editMsgId);
  }

  // ── Serialización ─────────────────────────────────────────────────────────

  toJSON() {
    return {
      key:              this.key,
      running:          this.running,
      botInfo:          this.botInfo,
      defaultAgent:     this.defaultAgent,
      whitelist:        this.whitelist,
      groupWhitelist:   this.groupWhitelist,
      rateLimit:        this.rateLimit,
      rateLimitKeyword: this.rateLimitKeyword,
      chats:            [...this.chats.values()],
    };
  }
}

// ── TelegramChannel (ex BotManager) ──────────────────────────────────────────

class TelegramChannel extends BaseChannel {
  constructor({
    botsFilePath      = null,
    botsRepo          = null,
    chatSettingsRepo  = null,
    convSvc           = null,
    sessionManager    = null,
    agents            = null,
    skills            = null,
    memory            = null,
    reminders         = null,
    mcps              = null,
    consolidator      = null,
    providers         = null,
    providerConfig    = null,
    chatSettings      = null,
    eventBus          = null,
    transcriber       = null,
    tts               = null,
    voiceProviders    = null,
    ttsConfig         = null,
    logger            = console,
  } = {}) {
    super({ eventBus, logger });
    this._botsFilePath    = botsFilePath || path.join(__dirname, '../../bots.json');
    this._botsRepo        = botsRepo || null;
    this._convSvc         = convSvc;
    this._sessionManager  = sessionManager;
    this._agents          = agents;
    this._skills          = skills;
    this._memory          = memory;
    this._reminders       = reminders;
    this._mcps            = mcps;
    this._consolidator    = consolidator;
    this._providers       = providers;
    this._providerConfig  = providerConfig;
    this._chatSettings    = chatSettingsRepo || chatSettings;
    this._eventBus        = eventBus;
    this._transcriber     = transcriber;
    this._tts             = tts;
    this._voiceProviders  = voiceProviders;
    this._ttsConfig       = ttsConfig;
    this._logger          = logger;

    /** @type {Map<string, TelegramBot>} */
    this.bots = new Map();
  }

  _buildBot(key, token, { initialOffset = 0, onOffsetSave = null } = {}) {
    const commandHandler = new CommandHandler({
      agents:        this._agents,
      skills:        this._skills,
      memory:        this._memory,
      reminders:     this._reminders,
      mcps:          this._mcps,
      consolidator:  this._consolidator,
      sessionManager: this._sessionManager,
      providers:     this._providers,
      providerConfig: this._providerConfig,
      chatSettings:  this._chatSettings,
      transcriber:   this._transcriber,
      tts:           this._tts,
      logger:        this._logger,
    });
    const callbackHandler = new CallbackHandler({
      agents:        this._agents,
      skills:        this._skills,
      memory:        this._memory,
      reminders:     this._reminders,
      mcps:          this._mcps,
      consolidator:  this._consolidator,
      providers:     this._providers,
      providerConfig: this._providerConfig,
      chatSettings:  this._chatSettings,
      transcriber:     this._transcriber,
      tts:             this._tts,
      voiceProviders:  this._voiceProviders,
      ttsConfig:       this._ttsConfig,
      logger:          this._logger,
    });
    const pendingHandler = new PendingActionHandler({
      skills: this._skills,
      mcps:   this._mcps,
      logger: this._logger,
    });
    const mediaHandler = new MediaHandler({
      transcriber: this._transcriber,
      logger:      this._logger,
    });
    const responseRenderer = new ResponseRenderer();
    const messageProcessor = new MessageProcessor({
      convSvc:        this._convSvc,
      sessionManager: this._sessionManager,
      agents:         this._agents,
      memory:         this._memory,
      chatSettings:   this._chatSettings,
      tts:            this._tts,
      events:         this._eventBus,
      logger:         this._logger,
    });

    return new TelegramBot(key, token, {
      initialOffset,
      onOffsetSave:     onOffsetSave || (() => this._saveFile()),
      commandHandler,
      callbackHandler,
      pendingHandler,
      mediaHandler,
      responseRenderer,
      messageProcessor,
      convSvc:        this._convSvc,
      sessionManager: this._sessionManager,
      agents:         this._agents,
      memory:         this._memory,
      consolidator:   this._consolidator,
      providers:      this._providers,
      providerConfig: this._providerConfig,
      chatSettings:   this._chatSettings,
      events:         this._eventBus,
      transcriber:    this._transcriber,
      tts:            this._tts,
      logger:         this._logger,
    });
  }

  // ── BaseChannel interface ─────────────────────────────────────────────────

  async start()  { return this.loadAndStart(); }

  async stop() {
    clearInterval(this._reminderInterval);
    this._reminderInterval = null;
    await Promise.all([...this.bots.values()].map(b => b.stop().catch(() => {})));
  }

  async send(destination, text) {
    for (const bot of this.bots.values()) {
      if (bot.running) {
        await bot.sendText(Number(destination), text);
        return;
      }
    }
    throw new Error('TelegramChannel: no hay bots en ejecución');
  }

  toJSON() { return { bots: this.listBots() }; }

  // ── Ciclo de vida ─────────────────────────────────────────────────────────

  async loadAndStart() {
    const saved = this._readFile();
    for (const entry of saved) {
      const { key, token, defaultAgent, whitelist, groupWhitelist, rateLimit, rateLimitKeyword, offset, startGreeting, lastGreetingAt } = entry;
      const bot = this._buildBot(key, token, { initialOffset: offset || 0 });
      if (defaultAgent) bot.defaultAgent = defaultAgent;

      const envWhitelist = (process.env.BOT_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);
      bot.whitelist = envWhitelist.length ? envWhitelist : (whitelist || []);

      const envGroupWhitelist = (process.env.BOT_GROUP_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);
      bot.groupWhitelist = envGroupWhitelist.length ? envGroupWhitelist : (groupWhitelist || []);

      if (rateLimit        !== undefined) bot.rateLimit = rateLimit;
      if (rateLimitKeyword !== undefined) bot.rateLimitKeyword = rateLimitKeyword;
      if (startGreeting    !== undefined) bot.startGreeting = startGreeting;
      if (lastGreetingAt)  bot.lastGreetingAt = lastGreetingAt;

      this.bots.set(key, bot);
      try { await bot.start(); }
      catch (err) { console.error(`[Telegram] No se pudo iniciar bot "${key}":`, err.message); }
    }

    this._reminderInterval = setInterval(() => this._checkReminders(), 30_000);
    this._reminderInterval.unref();
  }

  async _checkReminders() {
    if (!this._reminders) return;
    const triggered = this._reminders.popTriggered();
    for (const r of triggered) {
      const bot = this.bots.get(r.botKey);
      if (!bot || !bot.running) continue;
      try {
        await bot.sendWithButtons(r.chatId,
          `🔔 *¡Recordatorio!*\n\n📝 ${r.text}`,
          [[{ text: '✅ OK', callback_data: 'reminder_ack' }]]
        );
      } catch (err) {
        console.error(`[Reminders] No se pudo enviar a ${r.chatId}:`, err.message);
      }
    }
  }

  async addBot(key, token) {
    if (this.bots.has(key)) await this.bots.get(key).stop();
    const bot  = this._buildBot(key, token);
    const info = await bot.start();
    this.bots.set(key, bot);
    this._saveFile();
    return info;
  }

  async removeBot(key) {
    const bot = this.bots.get(key);
    if (!bot) return false;
    await bot.stop();
    this.bots.delete(key);
    this._saveFile();
    return true;
  }

  async startBot(key) {
    const bot = this.bots.get(key);
    if (!bot) throw new Error(`Bot "${key}" no encontrado`);
    return bot.start();
  }

  async stopBot(key) {
    const bot = this.bots.get(key);
    if (!bot) throw new Error(`Bot "${key}" no encontrado`);
    return bot.stop();
  }

  getBot(key)   { return this.bots.get(key); }
  listBots()    { return [...this.bots.values()].map(b => b.toJSON()); }

  linkSession(key, chatId, sessionId) {
    const bot = this.bots.get(key);
    if (!bot) return false;
    const chat = bot.chats.get(Number(chatId));
    if (!chat) return false;
    chat.sessionId = sessionId;
    return true;
  }

  disconnectChat(key, chatId) {
    const bot = this.bots.get(key);
    if (!bot) return false;
    return bot.chats.delete(Number(chatId));
  }

  setBotAgent(key, agentKey) {
    const bot = this.bots.get(key);
    if (!bot) throw new Error(`Bot "${key}" no encontrado`);
    bot.setDefaultAgent(agentKey);
    this._saveFile();
    return bot.toJSON();
  }

  saveBots() { this._saveFile(); }

  // ── Persistencia ─────────────────────────────────────────────────────────

  _readFile() {
    if (this._botsRepo) return this._botsRepo.read();
    try {
      if (fs.existsSync(this._botsFilePath)) {
        return JSON.parse(fs.readFileSync(this._botsFilePath, 'utf8')) || [];
      }
      const token = process.env.BOT_TOKEN;
      if (!token) return [];

      const whitelist = (process.env.BOT_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);
      const groupWhitelist = (process.env.BOT_GROUP_WHITELIST || '')
        .split(',').map(s => s.trim()).filter(Boolean).map(Number);

      const entry = {
        key:              process.env.BOT_KEY               || 'dev',
        token,
        defaultAgent:     process.env.BOT_DEFAULT_AGENT      || 'claude',
        whitelist,
        groupWhitelist,
        rateLimit:        parseInt(process.env.BOT_RATE_LIMIT) || 30,
        rateLimitKeyword: process.env.BOT_RATE_LIMIT_KEYWORD  || '',
        offset:           0,
      };
      fs.writeFileSync(this._botsFilePath, JSON.stringify([entry], null, 2), 'utf8');
      console.log(`[Telegram] bots.json creado desde variables de entorno (key: ${entry.key})`);
      return [entry];
    } catch { return []; }
  }

  _saveFile() {
    const data = [...this.bots.entries()].map(([key, bot]) => ({
      key,
      token:            bot.token,
      defaultAgent:     bot.defaultAgent,
      whitelist:        bot.whitelist,
      groupWhitelist:   bot.groupWhitelist,
      rateLimit:        bot.rateLimit,
      rateLimitKeyword: bot.rateLimitKeyword,
      startGreeting:    bot.startGreeting,
      lastGreetingAt:   bot.lastGreetingAt,
      offset:           bot.offset,
    }));
    if (this._botsRepo) { this._botsRepo.save(data); return; }
    try {
      fs.writeFileSync(this._botsFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] No se pudo guardar bots.json:', err.message);
    }
  }
}

module.exports = { TelegramChannel, TelegramBot };
