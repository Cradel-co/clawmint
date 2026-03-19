'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const os   = require('os');

const BaseChannel          = require('../BaseChannel');
const ClaudePrintSession   = require('../../core/ClaudePrintSession');
const ConsoleSession       = require('../../core/ConsoleSession');
const CommandHandler       = require('./CommandHandler');
const CallbackHandler      = require('./CallbackHandler');
const PendingActionHandler = require('./PendingActionHandler');

const TELEGRAM_HOST = 'api.telegram.org';
const POLL_TIMEOUT  = 25;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// ── Debug condicional (activar con DEBUG_TELEGRAM=1) ─────────────────────────
function _tgDebug() { return process.env.DEBUG_TELEGRAM === '1'; }
function tdbg(scope, ...args) {
  if (!_tgDebug()) return;
  console.log(`[TG:DBG:${scope}]`, ...args);
}

// ── Utilidades HTTP ──────────────────────────────────────────────────────────

function httpsPost(urlPath, body, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: TELEGRAM_HOST,
      path: urlPath,
      method: 'POST',
      family: 4,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Respuesta no es JSON: ' + raw.slice(0, 200))); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function cleanPtyOutput(raw) {
  let s = raw.replace(/\x1B\[(\d*)C/g, (_, n) => ' '.repeat(Number(n) || 1));
  s = s
    .replace(/\x1B\[[0-9;?]*[A-Za-z@]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[A-Z\\]/g, '')
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '');
  const lines = s.split('\n').map(line => {
    const segs = line.split('\r');
    let rendered = segs[0] || '';
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.length >= rendered.length) rendered = seg;
      else if (seg.length > 0) rendered = seg + rendered.slice(seg.length);
    }
    return rendered.trimEnd();
  });
  const filtered = lines.filter(line => {
    const t = line.trim();
    if (!t) return false;
    if (/^[─━═\-─]{4,}$/.test(t)) return false;
    if (/^[▐▛▜▌▝▘█▙▟▄▀■]+/.test(t)) return false;
    if (/^\?.*shortcuts/.test(t)) return false;
    if (/^ctrl\+/.test(t)) return false;
    if (/^❯\s*$/.test(t)) return false;
    return true;
  });
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripAnsi(str) { return cleanPtyOutput(str); }

function chunkText(text, size = 4096) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length > 0 ? chunks : [''];
}

// ── TelegramBot (instancia por bot) ──────────────────────────────────────────

class TelegramBot {
  constructor(key, token, {
    initialOffset = 0,
    onOffsetSave  = null,
    // Deps inyectadas (Fase 1 — opcionales con fallback a módulos legacy)
    commandHandler      = null,
    callbackHandler     = null,
    pendingHandler      = null,
    // ConversationService (Fase 5)
    convSvc             = null,
    // Otros deps para fallback PTY y _sendToApiProvider legacy
    sessionManager      = null,
    agents              = null,
    memory              = null,
    consolidator        = null,
    providers           = null,
    providerConfig      = null,
    chatSettings        = null,
    events              = null,
    transcriber         = null,
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

    // Deps
    this._commandHandler  = commandHandler;
    this._callbackHandler = callbackHandler;
    this._pendingHandler  = pendingHandler;
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
  _isClaudeBased(agentKey = this.defaultAgent) {
    if (agentKey === 'claude') return true;
    const def = this._agents ? this._agents.get(agentKey) : null;
    return !!(def && def.command && def.command.includes('claude'));
  }

  _claudeSessionOpts(chat) {
    return {
      model: chat.claudeSession?.model || null,
      permissionMode: chat.claudeMode || 'ask',
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

  // ── Start / Stop / Poll ──────────────────────────────────────────────────

  async start() {
    if (this.running) return { username: this.botInfo?.username };

    const me = await this._apiCall('getMe');
    this.botInfo = { id: me.id, username: me.username, firstName: me.first_name };
    this.running = true;

    try {
      await this._apiCall('setMyCommands', {
        commands: [
          { command: 'nueva',        description: 'Nueva conversación' },
          { command: 'modelo',       description: 'Ver o cambiar modelo' },
          { command: 'permisos',     description: 'Modo: auto/ask/plan' },
          { command: 'costo',        description: 'Costo de la sesión' },
          { command: 'estado',       description: 'Estado detallado' },
          { command: 'agentes',      description: 'Listar agentes' },
          { command: 'skills',       description: 'Skills instalados' },
          { command: 'consola',      description: 'Modo consola bash' },
          { command: 'recordar',     description: 'Crear recordatorio' },
          { command: 'ayuda',        description: 'Todos los comandos' },
        ],
      });
    } catch (e) { console.error(`[Telegram] setMyCommands falló: ${e.message}`); }

    this._poll();

    // Suscribir a sugerencias de tópicos del consolidador
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
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try { await this._handleUpdate(update); } catch (err) {
            console.error(`[Telegram:${this.key}] Error en update:`, err.message);
          }
        }
        if (updates.length > 0 && this._onOffsetSave) this._onOffsetSave();
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
      await this._handleVoiceMessage(msg);
      return;
    }
    if (!msg.text) return;
    await this._handleMessage(msg);
  }

  async _handleVoiceMessage(msg) {
    const chatId = msg.chat.id;
    if (!this._isAllowed(chatId, msg.chat.type)) {
      await this.sendText(chatId, '⛔ No tenés acceso a este bot.', msg.message_id);
      return;
    }
    const fileId   = msg.voice?.file_id || msg.audio?.file_id;
    const duration = msg.voice?.duration || msg.audio?.duration || 0;
    if (duration > 300) {
      await this.sendText(chatId, '⚠️ El audio es muy largo (máx 5 min).');
      return;
    }
    if (!this._transcriber) {
      await this.sendText(chatId, '❌ Módulo de transcripción no disponible.');
      return;
    }
    try {
      const fileInfo = await this._apiCall('getFile', { file_id: fileId });
      const fileUrl  = `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;
      const tmpFile  = path.join(os.tmpdir(), `clawmint_voice_${Date.now()}.ogg`);
      await this._transcriber.httpsDownload(fileUrl, tmpFile);
      await this.sendText(chatId, '🎙️ Transcribiendo audio...');
      const text = await this._transcriber.transcribe(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch {}
      if (!text || !text.trim()) {
        await this.sendText(chatId, '⚠️ No se pudo extraer texto del audio.');
        return;
      }
      console.log(`[Telegram:${this.key}] Audio transcrito de ${chatId}: ${text.slice(0, 60)}`);
      msg.text = text;
      await this._handleMessage(msg);
    } catch (err) {
      console.error(`[Telegram:${this.key}] Error procesando audio:`, err.message);
      await this.sendText(chatId, `❌ Error al procesar audio: ${err.message}`);
    }
  }

  async _handleMessage(msg) {
    // Deduplicar por message_id (re-entrega de updates)
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

    // Deduplicar por contenido+chat (mismo texto en <2s = tap doble o retry)
    if (!this._lastMsgByChat) this._lastMsgByChat = new Map();
    const dedupKey = `${msg.chat.id}:${(msg.text || '').trim()}`;
    const lastTs   = this._lastMsgByChat.get(dedupKey) || 0;
    const now      = Date.now();
    if (now - lastTs < 2000) {
      tdbg('dedup', `SKIP "${(msg.text||'').slice(0,30)}" (mismo texto en ${now - lastTs}ms)`);
      return;
    }
    this._lastMsgByChat.set(dedupKey, now);
    // Limpiar entries viejas
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

      // Restaurar sesión de Claude desde SQLite si hay una guardada
      let restoredSession = null;
      if (saved?.claude_session_id && saved.message_count > 0) {
        restoredSession = new ClaudePrintSession({
          claudeSessionId: saved.claude_session_id,
          messageCount:    saved.message_count,
          cwd:             saved.cwd || process.env.HOME,
          model:           saved.model || null,
        });
        tdbg('init', `restored session ${saved.claude_session_id.slice(0,8)}… msgCount=${saved.message_count} cwd=${saved.cwd}`);
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
        model:          saved?.model    || null,
        aiHistory:      [],
        claudeMode:     'ask',
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
      await this._sendToSession(chatId, text, chat);
    }
  }

  async _handleCommand(msg, cmd, args, chat) {
    if (this._commandHandler) {
      return await this._commandHandler.handle(this, msg, cmd, args, chat);
    }
    // Fallback mínimo
    await this.sendText(msg.chat.id, `❓ Comando desconocido: /${cmd}`);
  }

  async _handleCallbackQuery(cbq) {
    if (this._callbackHandler) {
      return await this._callbackHandler.handle(this, cbq);
    }
  }

  // ── Helpers de animación y envío ─────────────────────────────────────────

  async _startDotAnimation(chatId, mode = 'ask') {
    const modeLabels = { ask: 'ask', plan: 'plan-mode', auto: 'auto-accept' };
    const label = modeLabels[mode] || mode;
    let sentMsg = null;
    try { sentMsg = await this._apiCall('sendMessage', { chat_id: chatId, text: label + '.' }); } catch {}
    if (!sentMsg) return { sentMsg: null, stop: () => {} };

    let dotCount = 1, dotDir = 1, stopped = false;
    const interval = setInterval(async () => {
      if (stopped) return;
      dotCount += dotDir;
      if (dotCount >= 3) { dotCount = 3; dotDir = -1; }
      else if (dotCount <= 1) { dotCount = 1; dotDir = 1; }
      try {
        await this._apiCall('editMessageText', {
          chat_id: chatId, message_id: sentMsg.message_id,
          text: label + '.'.repeat(dotCount),
        });
      } catch {}
    }, 1000);

    const stop = () => { stopped = true; clearInterval(interval); };
    return { sentMsg, stop };
  }

  async _sendResult(chatId, text, sentMsg) {
    const finalText = cleanPtyOutput(text || '').trim();
    tdbg('result', `chatId=${chatId} rawLen=${(text||'').length} cleanLen=${finalText.length} hasSentMsg=${!!sentMsg}`);
    if (!finalText) { tdbg('result', `SKIP — finalText vacío`); return; }

    const postButtons = [
      [{ text: '▶ Seguir',             callback_data: 'postreply:continue' },
       { text: '🔄 Nueva conv',         callback_data: 'postreply:new' }],
      [{ text: '💾 Guardar en memoria', callback_data: 'postreply:save' }],
    ];

    const chunks = chunkText(finalText, 4096);
    const lastIdx = chunks.length - 1;
    tdbg('result', `${chunks.length} chunk(s), first=${chunks[0]?.slice(0, 80)}`);

    if (sentMsg) {
      if (chunks.length === 1) {
        tdbg('result', `editando msg ${sentMsg.message_id} con botones`);
        await this.sendWithButtons(chatId, chunks[0], postButtons, sentMsg.message_id);
      } else {
        try {
          await this._apiCall('editMessageText', { chat_id: chatId, message_id: sentMsg.message_id, text: chunks[0] });
        } catch (e) { tdbg('result', `editMsg FAIL: ${e.message}`); await this.sendText(chatId, chunks[0]); }
        for (let i = 1; i < lastIdx; i++) await this.sendText(chatId, chunks[i]);
        await this.sendWithButtons(chatId, chunks[lastIdx], postButtons);
      }
    } else {
      tdbg('result', `enviando ${chunks.length} chunk(s) como mensajes nuevos`);
      for (let i = 0; i < lastIdx; i++) await this.sendText(chatId, chunks[i]);
      await this.sendWithButtons(chatId, chunks[lastIdx], postButtons);
    }
    tdbg('result', `OK`);
  }

  // ── Envío a sesión / provider ─────────────────────────────────────────────

  async _sendToSession(chatId, text, chat) {
    tdbg('send', `chatId=${chatId} text="${text.slice(0, 80)}" busy=${chat.busy}`);
    if (chat.busy) {
      tdbg('send', `SKIP — chat busy`);
      try { await this._apiCall('sendMessage', { chat_id: chatId, text: '⏳ Procesando tu mensaje anterior, aguardá un momento...' }); } catch {}
      return;
    }
    chat.busy = true;

    // ── Ruta PTY: agentes no-claude sin provider API ─────────────────────────
    const chatProvider = chat.provider || 'claude-code';
    const agentKey     = chat.activeAgent?.key || chat.activeAgent || this.defaultAgent;
    const useConvSvc   = this._convSvc && (chatProvider !== 'claude-code' || this._isClaudeBased(agentKey));
    tdbg('send', `provider=${chatProvider} agent=${agentKey} useConvSvc=${useConvSvc} hasConvSvc=${!!this._convSvc}`);

    if (!useConvSvc) {
      // Agentes PTY (bash, custom commands, etc.)
      tdbg('send', `→ ruta PTY`);
      try {
        const session  = await this.getOrCreateSession(chatId, chat);
        tdbg('send', `PTY session=${session?.id} active=${session?.active}`);
        const fromName = chat.firstName || chat.username || `chat${chatId}`;
        if (this._events) this._events.emit('telegram:session', { sessionId: session.id, from: fromName, text });
        session.injectOutput(`\r\n\x1b[34m┌─ 📨 Telegram: ${fromName}\x1b[0m\r\n`);
        try { await this._apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch {}
        const result   = await session.sendMessage(text, { timeout: 1080000, stableMs: 3000 });
        const response = cleanPtyOutput(result.raw || '');
        tdbg('send', `PTY response=${response?.length || 0} chars`);
        if (response) await this.sendText(chatId, response);
      } catch (err) {
        console.error(`[Telegram:${this.key}] Error PTY chat ${chatId}:`, err.message);
        tdbg('send', `PTY ERROR: ${err.stack || err.message}`);
        try { await this.sendText(chatId, `⚠️ Error: ${err.message}`); } catch {}
      } finally {
        chat.busy = false;
      }
      return;
    }

    // ── Ruta ConversationService: claude-code y providers API ────────────────
    tdbg('send', `→ ruta ConvSvc`);
    const mode = chat.claudeMode || 'ask';
    tdbg('send', `mode=${mode} model=${chat.model} hasClaudeSession=${!!chat.claudeSession} msgCount=${chat.claudeSession?.messageCount || 0}`);
    const { sentMsg, stop: stopAnim } = await this._startDotAnimation(chatId, mode);
    tdbg('send', `dotAnim sentMsg=${sentMsg?.message_id || 'null'}`);

    let lastEditAt  = 0;
    const THROTTLE  = 1500;
    let animStopped = false;
    let chunkCount  = 0;

    const onChunk = async (partial) => {
      chunkCount++;
      if (!partial.trim() || !sentMsg) { tdbg('chunk', `#${chunkCount} SKIP empty=${!partial.trim()} noMsg=${!sentMsg}`); return; }
      if (!animStopped) { animStopped = true; stopAnim(); tdbg('chunk', `#${chunkCount} anim stopped`); }
      const now = Date.now();
      if (now - lastEditAt < THROTTLE) { tdbg('chunk', `#${chunkCount} throttled (${now - lastEditAt}ms)`); return; }
      lastEditAt = now;
      try {
        const preview = cleanPtyOutput(partial).slice(0, 4000) || partial.slice(0, 4000);
        tdbg('chunk', `#${chunkCount} editMsg len=${preview.length}`);
        await this._apiCall('editMessageText', { chat_id: chatId, message_id: sentMsg.message_id, text: preview });
        tdbg('chunk', `#${chunkCount} editMsg OK`);
      } catch (e) { tdbg('chunk', `#${chunkCount} editMsg FAIL: ${e.message}`); }
    };

    try {
      // Inyectar reminder de notas guardadas en sesión en curso
      let messageText = text;
      if (chatProvider === 'claude-code' && chat._savedInSession?.length > 0 && chat.claudeSession?.messageCount > 0) {
        messageText = `[Notas guardadas en esta conversación: ${chat._savedInSession.join(', ')}]\n\n${text}`;
        tdbg('send', `injected saved notes: ${chat._savedInSession.join(', ')}`);
      }

      tdbg('send', `→ convSvc.processMessage() provider=${chatProvider} agent=${agentKey} textLen=${messageText.length}`);
      const t0 = Date.now();
      const result = await this._convSvc.processMessage({
        chatId,
        agentKey,
        provider:      chatProvider,
        model:         chat.model,
        text:          messageText,
        history:       chat.aiHistory || [],
        claudeSession: chat.claudeSession,
        claudeMode:    mode,
        onChunk,
        shellId:       String(chatId),
      });
      tdbg('send', `← convSvc.processMessage() ${Date.now() - t0}ms chunks=${chunkCount} resultText=${(result.text || '').length} chars newSession=${!!result.newSession} savedFiles=${result.savedMemoryFiles?.length || 0}`);

      stopAnim();
      if (!animStopped && sentMsg) {
        tdbg('send', `deleting dot msg (no chunks received)`);
        try { await this._apiCall('deleteMessage', { chat_id: chatId, message_id: sentMsg.message_id }); } catch (e) { tdbg('send', `deleteMsg FAIL: ${e.message}`); }
      }

      if (result.newSession)       chat.claudeSession = result.newSession;
      if (result.history)          chat.aiHistory     = result.history;

      // Persistir sesión de Claude en SQLite para sobrevivir reinicios
      // Usar monitorCwd (directorio elegido por el usuario) en vez de claudeSession.cwd
      // para no sobreescribir el cwd del usuario con el cwd interno de Claude
      if (chat.claudeSession?.claudeSessionId && this._chatSettings) {
        this._chatSettings.saveSession(this.key, chatId, {
          claudeSessionId: chat.claudeSession.claudeSessionId,
          messageCount:    chat.claudeSession.messageCount,
          cwd:             chat.monitorCwd || chat.claudeSession.cwd,
        });
      }

      if (result.savedMemoryFiles?.length > 0) {
        if (!chat._savedInSession) chat._savedInSession = [];
        for (const f of result.savedMemoryFiles) {
          if (!chat._savedInSession.includes(f)) chat._savedInSession.push(f);
        }
      }

      tdbg('send', `→ _sendResult() textLen=${(result.text || '').length} hasSentMsg=${!!(animStopped ? sentMsg : null)}`);
      await this._sendResult(chatId, result.text || '', animStopped ? sentMsg : null);
      tdbg('send', `← _sendResult() OK`);
    } catch (err) {
      stopAnim();
      console.error(`[Telegram:${this.key}] Error en chat ${chatId}:`, err.message);
      tdbg('send', `CATCH ERROR: ${err.stack || err.message}`);
      // Si Claude falló, limpiar sesión rota para que el próximo mensaje no reintente --resume
      if (chat.claudeSession && err.message?.includes('código')) {
        tdbg('send', `limpiando sesión rota`);
        chat.claudeSession.claudeSessionId = null;
        chat.claudeSession.messageCount = 0;
        if (this._chatSettings) this._chatSettings.clearSession(this.key, chatId);
      }
      const errMsg = `⚠️ Error: ${err.message}`;
      try {
        if (sentMsg) {
          await this._apiCall('editMessageText', { chat_id: chatId, message_id: sentMsg.message_id, text: errMsg });
        } else { await this.sendText(chatId, errMsg); }
      } catch (e2) { tdbg('send', `error-send FAIL: ${e2.message}`); }
    } finally {
      chat.busy = false;
      tdbg('send', `DONE busy=false`);
    }
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

  // ── Modo consola (delega a core/ConsoleSession) ─────────────────────────

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
    // Adaptar formato genérico { text, command } → Telegram { text, callback_data }
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
      } catch (e) { if (!e.message?.includes('not modified')) throw e; }
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
    // storage
    botsFilePath      = null,
    botsRepo          = null,   // BotsRepository (opcional; si no se da, usa botsFilePath)
    chatSettingsRepo  = null,   // ChatSettingsRepository (opcional; si no se da, usa chatSettings)
    // ConversationService (Fase 5)
    convSvc           = null,
    // deps de dominio
    sessionManager    = null,
    agents            = null,
    skills            = null,
    memory            = null,
    reminders         = null,
    mcps              = null,
    consolidator      = null,
    providers         = null,
    providerConfig    = null,
    chatSettings      = null,   // legacy (chat-settings.js) — usado si chatSettingsRepo es null
    eventBus          = null,
    transcriber       = null,
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
    this._chatSettings    = chatSettingsRepo || chatSettings;   // ChatSettingsRepository tiene la misma interfaz
    this._eventBus        = eventBus;
    this._transcriber     = transcriber;
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
      transcriber:   this._transcriber,
      logger:        this._logger,
    });
    const pendingHandler = new PendingActionHandler({
      skills: this._skills,
      mcps:   this._mcps,
      logger: this._logger,
    });

    return new TelegramBot(key, token, {
      initialOffset,
      onOffsetSave:   onOffsetSave || (() => this._saveFile()),
      commandHandler,
      callbackHandler,
      pendingHandler,
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
      logger:         this._logger,
    });
  }

  // ── BaseChannel interface ─────────────────────────────────────────────────

  /** Conectar: carga bots y arranca polling */
  async start()  { return this.loadAndStart(); }

  /** Desconectar: para todos los bots y limpia el intervalo de recordatorios */
  async stop() {
    clearInterval(this._reminderInterval);
    this._reminderInterval = null;
    await Promise.all([...this.bots.values()].map(b => b.stop().catch(() => {})));
  }

  /**
   * Envía un mensaje de texto a través del primer bot en ejecución.
   * @param {number|string} destination - chatId
   * @param {string} text
   */
  async send(destination, text) {
    for (const bot of this.bots.values()) {
      if (bot.running) {
        await bot.sendText(Number(destination), text);
        return;
      }
    }
    throw new Error('TelegramChannel: no hay bots en ejecución');
  }

  /** Estado serializable (para la API REST) */
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

    // Checker de recordatorios cada 30s
    this._reminderInterval = setInterval(() => this._checkReminders(), 30_000);
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
    // Fallback inline (sin BotsRepository)
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
    // Fallback inline
    try {
      fs.writeFileSync(this._botsFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[Telegram] No se pudo guardar bots.json:', err.message);
    }
  }
}

module.exports = { TelegramChannel, TelegramBot };
