'use strict';

const path = require('path');
const ClaudePrintSession = require('../../core/ClaudePrintSession');

const MCP_CONFIG_PATH = path.join(__dirname, '..', '..', 'mcp-config.json');

/**
 * P2PBotAdapter — adaptador que implementa la interfaz de "bot" que
 * CommandHandler y CallbackHandler esperan, pero envía por DataChannel.
 *
 * Traduce sendText/sendWithButtons a mensajes del protocolo DataChannel:
 * - sendText → { type: 'output', data } + { type: 'exit' }
 * - sendWithButtons → { type: 'buttons', data: { text, buttons } }
 */
class P2PBotAdapter {
  constructor({ send, chat, container, callbackHandler }) {
    this._send = send;
    this._chat = chat;
    this._container = container;
    this._callbackHandler = callbackHandler;
    this._chats = new Map();
    this._chats.set(chat.chatId, chat);
  }

  get key() { return 'p2p'; }
  get defaultAgent() { return this._chat.activeAgent?.key || 'claude'; }
  get botInfo() { return { username: 'deskcritter' }; }
  get chats() { return this._chats; }
  get whitelist() { return []; }
  set whitelist(_v) {}

  _isClaudeBased() {
    return !this._chat.provider || this._chat.provider === 'claude-code';
  }

  _isAllowed() { return true; }

  _claudeSessionOpts(chat) {
    return {
      permissionMode: chat.claudeMode || 'auto',
      model: chat.model || null,
      cwd: chat.monitorCwd || process.env.HOME || process.cwd(),
      claudeSessionId: chat.claudeSession?.claudeSessionId || null,
      messageCount: chat.claudeSession?.messageCount || 0,
      mcpConfig: MCP_CONFIG_PATH,
    };
  }

  async sendText(chatId, text) {
    this._send({ type: 'output', data: text });
    this._send({ type: 'exit' });
  }

  async sendWithButtons(chatId, text, buttons, editMsgId) {
    // Normalizar formato de botones (algunos usan 'id' en vez de 'callback_data')
    const normalized = buttons.map(row =>
      row.map(btn => ({
        text: btn.text,
        callback_data: btn.callback_data || btn.id,
      }))
    );
    this._send({ type: 'buttons', data: { text, buttons: normalized } });
  }

  async _sendMenu(chatId, editMsgId) {
    if (!this._callbackHandler) return;
    const def = this._callbackHandler.getMenuDef('menu', { bot: this });
    if (!def) return;
    const chat = this._chats.get(chatId) || this._chat;
    const text = typeof def.text === 'function' ? def.text(chat) : def.text;
    const buttons = typeof def.buttons === 'function' ? def.buttons(chat) : def.buttons;
    // Normalizar: menu defs usan 'id', convertir a 'callback_data'
    const normalized = buttons.map(row =>
      row.map(btn => ({
        text: btn.text,
        callback_data: btn.callback_data || btn.id,
      }))
    );
    await this.sendWithButtons(chatId, text, normalized, editMsgId);
  }

  async _answerCallback(id, text) {
    // No-op: no hay callback query de Telegram
  }

  _onOffsetSave() {
    // No-op: no hay offset de Telegram
  }

  async getOrCreateSession(chatId, chat, force, type) {
    const sm = this._container.sessionManager;
    if (!force && chat.sessionId) {
      const existing = sm.get(chat.sessionId);
      if (existing) return existing;
    }
    const session = sm.create({ type: 'pty', command: type || null, cols: 80, rows: 24 });
    chat.sessionId = session.id;
    return session;
  }

  async _sendToSession(chatId, text, chat) {
    const convSvc = this._container.convSvc;
    let lastChunkSent = '';

    const mode = chat.claudeMode || 'auto';
    const isMcpMode = mode === 'auto';
    const provider = chat.provider || 'claude-code';

    const onChunk = isMcpMode ? null : (accumulated) => {
      const delta = accumulated.slice(lastChunkSent.length);
      if (delta) {
        this._send({ type: 'output', data: delta });
        lastChunkSent = accumulated;
      }
    };

    const onStatus = isMcpMode ? (status, detail) => {
      this._send({ type: 'status', data: { status, detail } });
    } : null;

    // Callback de aprobación para modo ask (providers API)
    const dynamicRegistry = require('../telegram/DynamicCallbackRegistry');
    const onAskPermission = mode === 'ask' && provider !== 'claude-code'
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
            this.sendWithButtons(chatId,
              `🔧 ${toolName}\n${preview}\n¿Permitir?`,
              [[
                { text: '✅ Permitir', callback_data: approveId },
                { text: '❌ Rechazar', callback_data: rejectId },
              ]]
            );
          });
        }
      : null;

    try {
      chat.busy = true;
      const result = await convSvc.processMessage({
        chatId,
        agentKey: this.defaultAgent,
        provider,
        model: chat.model || null,
        text,
        history: chat.aiHistory || [],
        claudeSession: chat.claudeSession,
        claudeMode: mode,
        onChunk,
        onStatus,
        onAskPermission,
        shellId: `p2p-${chatId}`,
      });

      // Si no hubo streaming, enviar texto completo
      if (result.text && !lastChunkSent) {
        this._send({ type: 'output', data: result.text });
      }

      // Actualizar estado
      if (result.history) chat.aiHistory = result.history;
      if (result.newSession) chat.claudeSession = result.newSession;

      // TTS — sintetizar audio y enviar por DataChannel
      try {
        const tts = this._container.tts;
        if (tts?.isEnabled() && result.text) {
          const audioBuffer = await tts.synthesize(result.text);
          if (audioBuffer) {
            this._send({ type: 'voice', data: audioBuffer.toString('base64') });
          }
        }
      } catch {}

      // Señalizar fin de streaming antes de los botones
      this._send({ type: 'exit' });

      // Botones post-respuesta
      this._send({ type: 'buttons', data: {
        text: '',
        buttons: [[
          { text: '▶ Continuar', callback_data: 'postreply:continue' },
          { text: '🔄 Nueva', callback_data: 'postreply:new' },
        ]]
      }});
    } catch (err) {
      this._send({ type: 'output', data: `Error: ${err.message}` });
      this._send({ type: 'exit' });
    }

    chat.busy = false;
  }

  async _handleConsoleInput(chatId, command, chat) {
    // Ejecutar comando shell y enviar resultado
    try {
      const sm = this._container.sessionManager;
      let session;
      if (chat._consoleSessionId) {
        session = sm.get(chat._consoleSessionId);
      }
      if (!session) {
        session = sm.create({ type: 'pty', command: 'bash', cols: 80, rows: 24 });
        chat._consoleSessionId = session.id;
      }
      const output = await session.sendMessage(command);
      this._send({ type: 'output', data: output || '(sin salida)' });
      this._send({ type: 'exit' });
    } catch (err) {
      await this.sendText(chatId, `Error: ${err.message}`);
    }
  }
}

module.exports = P2PBotAdapter;
