'use strict';

const { cleanPtyOutput, tdbg } = require('./utils');
const dynamicRegistry = require('./DynamicCallbackRegistry');

/**
 * MessageProcessor — lógica de envío a sesión PTY o ConversationService.
 *
 * Extraído de TelegramBot._sendToSession.
 * Recibe `bot` como primer parámetro (patrón CommandHandler).
 */
class MessageProcessor {
  constructor({
    convSvc        = null,
    sessionManager = null,
    agents         = null,
    memory         = null,
    chatSettings   = null,
    tts            = null,
    events         = null,
    logger         = console,
  } = {}) {
    this._convSvc        = convSvc;
    this._sessionManager = sessionManager;
    this._agents         = agents;
    this._memory         = memory;
    this._chatSettings   = chatSettings;
    this._tts            = tts;
    this._events         = events;
    this._logger         = logger;
  }

  async process(bot, chatId, text, chat, images = null, existingStatusMsg = null) {
    tdbg('send', `chatId=${chatId} text="${text.slice(0, 80)}" busy=${chat.busy}`);
    if (chat.busy) {
      tdbg('send', `SKIP — chat busy`);
      try { await bot._apiCall('sendMessage', { chat_id: chatId, text: '⏳ Procesando tu mensaje anterior, aguardá un momento...' }); } catch {}
      return;
    }
    chat.busy = true;

    // ── Ruta PTY: agentes no-claude sin provider API ─────────────────────────
    const chatProvider = chat.provider || 'claude-code';
    const agentKey     = chat.activeAgent?.key || chat.activeAgent || bot.defaultAgent;
    const useConvSvc   = this._convSvc && (chatProvider !== 'claude-code' || bot._isClaudeBased(agentKey));
    tdbg('send', `provider=${chatProvider} agent=${agentKey} useConvSvc=${useConvSvc} hasConvSvc=${!!this._convSvc}`);

    if (!useConvSvc) {
      tdbg('send', `→ ruta PTY`);
      try {
        const session  = await bot.getOrCreateSession(chatId, chat);
        tdbg('send', `PTY session=${session?.id} active=${session?.active}`);
        const fromName = chat.firstName || chat.username || `chat${chatId}`;
        if (this._events) this._events.emit('telegram:session', { sessionId: session.id, from: fromName, text });
        session.injectOutput(`\r\n\x1b[34m┌─ 📨 Telegram: ${fromName}\x1b[0m\r\n`);
        try { await bot._apiCall('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch {}
        const result   = await session.sendMessage(text, { timeout: 1080000, stableMs: 3000 });
        const response = cleanPtyOutput(result.raw || '');
        tdbg('send', `PTY response=${response?.length || 0} chars`);
        if (response) {
          // Guardar respuesta PTY en historial de la UI
          bot._tgMsgsRepo?.push(bot.key, String(chatId), 'bot', response);
          bot._events?.emit('telegram:ui:message', {
            botKey: bot.key, chatId, role: 'bot', text: response,
            ts: Date.now(), tgMsgId: null, chat,
          });
          await bot.sendText(chatId, response);
        }
      } catch (err) {
        console.error(`[Telegram:${bot.key}] Error PTY chat ${chatId}:`, err.message);
        tdbg('send', `PTY ERROR: ${err.stack || err.message}`);
        try { await bot.sendText(chatId, `⚠️ Error: ${err.message}`); } catch {}
      } finally {
        chat.busy = false;
      }
      return;
    }

    // ── Ruta ConversationService: claude-code y providers API ────────────────
    tdbg('send', `→ ruta ConvSvc`);
    const mode = chat.claudeMode || 'auto';
    tdbg('send', `mode=${mode} model=${chat.model} hasClaudeSession=${!!chat.claudeSession} msgCount=${chat.claudeSession?.messageCount || 0}`);

    let sentMsg, stopAnim;
    if (existingStatusMsg) {
      sentMsg = existingStatusMsg;
      stopAnim = () => {};
      tdbg('send', `reusing statusMsg=${sentMsg.message_id}`);
    } else {
      ({ sentMsg, stop: stopAnim } = await bot._responseRenderer.startDotAnimation(bot, chatId, mode));
      tdbg('send', `dotAnim sentMsg=${sentMsg?.message_id || 'null'}`);
    }

    let lastEditAt  = 0;
    const THROTTLE  = 1500;
    let animStopped = false;

    const STATUS_MAP = {
      transcribing: '🎙️ Transcribiendo audio...',
      thinking:     '🧠 Pensando...',
      tool_use:     '⚡ Ejecutando',
      done:         '✅ Listo',
    };

    let lastStatus = null;

    const onStatus = async (status, detail) => {
      if (!sentMsg) return;
      if (!animStopped) { animStopped = true; stopAnim(); }
      const now = Date.now();
      if (now - lastEditAt < THROTTLE && status === lastStatus) return;
      lastEditAt = now;
      lastStatus = status;
      let statusText = STATUS_MAP[status] || `⏳ ${status}`;
      if (status === 'tool_use' && detail) statusText = `⚡ ${detail}...`;
      try {
        await bot._apiCall('editMessageText', { chat_id: chatId, message_id: sentMsg.message_id, text: statusText });
        tdbg('status', `${status} ${detail || ''}`);
      } catch (e) { tdbg('status', `editMsg FAIL: ${e.message}`); }
    };

    const onChunk = null;

    try {
      let messageText = text;
      if (chatProvider === 'claude-code' && chat._savedInSession?.length > 0 && chat.claudeSession?.messageCount > 0) {
        messageText = `[Notas guardadas en esta conversación: ${chat._savedInSession.join(', ')}]\n\n${text}`;
        tdbg('send', `injected saved notes: ${chat._savedInSession.join(', ')}`);
      }

      const onAskPermission = mode === 'ask' && chatProvider !== 'claude-code'
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
              bot.sendWithButtons(chatId,
                `🔧 *${toolName}*\n\`\`\`\n${preview}\n\`\`\`\n¿Permitir?`,
                [[
                  { text: '✅ Permitir', callback_data: approveId },
                  { text: '❌ Rechazar', callback_data: rejectId },
                ]]
              ).catch(() => { clearTimeout(timeout); resolve(false); });
            });
          }
        : null;

      tdbg('send', `→ convSvc.processMessage() provider=${chatProvider} agent=${agentKey} textLen=${messageText.length} mode=${mode}`);
      const t0 = Date.now();
      const result = await this._convSvc.processMessage({
        chatId,
        agentKey,
        provider:      chatProvider,
        model:         chat.model,
        text:          messageText,
        images:        images || null,
        history:       chat.aiHistory || [],
        claudeSession: chat.claudeSession,
        geminiSession: chat.geminiSession,
        claudeMode:    mode,
        onChunk,
        onStatus,
        onAskPermission,
        shellId:       String(chatId),
        botKey:        bot.key,
        channel:       'telegram',
      });
      tdbg('send', `← convSvc.processMessage() ${Date.now() - t0}ms resultText=${(result.text || '').length} chars usedMcpTools=${result.usedMcpTools} newSession=${!!result.newSession} savedFiles=${result.savedMemoryFiles?.length || 0}`);

      if (result.usage) {
        if (!chat.usage) chat.usage = { promptTokens: 0, completionTokens: 0, messageCount: 0 };
        chat.usage.promptTokens += result.usage.promptTokens || 0;
        chat.usage.completionTokens += result.usage.completionTokens || 0;
        chat.usage.messageCount++;
      }

      stopAnim();

      if (result.newSession)       chat.claudeSession  = result.newSession;
      if (result.newGeminiSession) chat.geminiSession  = result.newGeminiSession;
      if (result.history)          chat.aiHistory      = result.history;

      if (chat.claudeSession?.claudeSessionId && this._chatSettings) {
        this._chatSettings.saveSession(bot.key, chatId, {
          claudeSessionId: chat.claudeSession.claudeSessionId,
          messageCount:    chat.claudeSession.messageCount,
          cwd:             chat.monitorCwd || chat.claudeSession.cwd,
        });
      }

      if (result.history && this._chatSettings && !['claude-code', 'gemini-cli'].includes(chatProvider)) {
        this._chatSettings.saveHistory(bot.key, chatId, result.history);
      }

      if (result.savedMemoryFiles?.length > 0) {
        if (!chat._savedInSession) chat._savedInSession = [];
        for (const f of result.savedMemoryFiles) {
          if (!chat._savedInSession.includes(f)) chat._savedInSession.push(f);
        }
      }

      if (result.text && !result.usedMcpTools) {
        // Guardar respuesta del bot en historial de la UI
        bot._tgMsgsRepo?.push(bot.key, String(chatId), 'bot', result.text);
        bot._events?.emit('telegram:ui:message', {
          botKey: bot.key, chatId, role: 'bot', text: result.text,
          ts: Date.now(), tgMsgId: null, chat,
        });

        // Fallback: la IA no usó MCP tools para comunicarse → enviar texto directo
        tdbg('send', `fallback: enviando texto directo (${result.text.length} chars, usedMcpTools=false)`);
        await bot._responseRenderer.sendResult(bot, chatId, result.text, sentMsg);
      } else if (sentMsg) {
        try { await bot._apiCall('deleteMessage', { chat_id: chatId, message_id: sentMsg.message_id }); } catch (e) { tdbg('send', `deleteStatusMsg FAIL: ${e.message}`); }
      }

      if (this._tts && this._tts.isEnabled() && result.text) {
        try {
          const audioBuffer = await this._tts.synthesize(result.text);
          if (audioBuffer) await bot.sendVoice(chatId, audioBuffer);
        } catch (err) {
          tdbg('tts', `Error TTS: ${err.message}`);
        }
      }
    } catch (err) {
      stopAnim();
      console.error(`[Telegram:${bot.key}] Error en chat ${chatId}:`, err.message);
      tdbg('send', `CATCH ERROR: ${err.stack || err.message}`);
      if (chat.claudeSession && err.message?.includes('código')) {
        tdbg('send', `limpiando sesión rota`);
        chat.claudeSession.claudeSessionId = null;
        chat.claudeSession.messageCount = 0;
        if (this._chatSettings) this._chatSettings.clearSession(bot.key, chatId);
      }
      const errMsg = `⚠️ Error: ${err.message}`;
      try {
        if (sentMsg) {
          await bot._apiCall('editMessageText', { chat_id: chatId, message_id: sentMsg.message_id, text: errMsg });
        } else { await bot.sendText(chatId, errMsg); }
      } catch (e2) { tdbg('send', `error-send FAIL: ${e2.message}`); }
    } finally {
      chat.busy = false;
      tdbg('send', `DONE busy=false`);
    }
  }
}

module.exports = MessageProcessor;
