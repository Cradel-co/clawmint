'use strict';

/**
 * TelegramUIHandler — WebSocket bridge para el TelegramPanel del navegador.
 *
 * Los clientes se conectan con { type: 'init', sessionType: 'telegram-ui' }.
 * Cuando llega un mensaje al bot (via EventBus 'telegram:ui:message'),
 * se hace broadcast a todos los clientes conectados.
 *
 * Protocolo servidor → cliente:
 *   { type: 'tg:message',      botKey, chatId, message: { role, text, ts, tgMsgId } }
 *   { type: 'tg:chats_update', botKey, chats: [...] }
 *
 * Protocolo cliente → servidor:
 *   { type: 'tg:open', botKey, chatId }  — resetea unreadCount del chat
 */

class TelegramUIHandler {
  /**
   * @param {{ telegram: object, logger?: object }} opts
   */
  constructor({ telegram, logger = console }) {
    this._telegram = telegram;
    this._logger   = logger;
    /** @type {Set<import('ws').WebSocket>} */
    this._clients  = new Set();
  }

  /**
   * Llamado desde pty-handler.js cuando sessionType === 'telegram-ui'.
   * @param {import('ws').WebSocket} ws
   */
  handleConnection(ws) {
    this._clients.add(ws);

    // Enviar snapshot inicial de todos los bots/chats
    this._sendSnapshot(ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'tg:open') {
          this._handleOpen(ws, msg);
        }
      } catch {}
    });

    ws.on('close', () => {
      this._clients.delete(ws);
    });
  }

  /**
   * Llamado desde EventBus cuando llega un mensaje al bot.
   * @param {{ botKey: string, chatId: number, role: string, text: string, ts: number, tgMsgId?: number, chat: object }} data
   */
  notifyNewMessage({ botKey, chatId, role, text, ts, tgMsgId, chat }) {
    const message = { role, text, ts, tgMsgId: tgMsgId || null };
    this.broadcast({ type: 'tg:message', botKey, chatId, message });

    // También broadcast del estado actualizado de chats del bot
    this._broadcastChatsUpdate(botKey);
  }

  /**
   * Envía un evento a todos los clientes WS conectados.
   * @param {object} event
   */
  broadcast(event) {
    const json = JSON.stringify(event);
    for (const ws of this._clients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(json); } catch {}
      }
    }
  }

  // ── Privado ────────────────────────────────────────────────────────────────

  /** Envía snapshot de todos los bots al conectar. */
  _sendSnapshot(ws) {
    if (!this._telegram) return;
    try {
      const bots = this._telegram.listBots ? this._telegram.listBots() : [];
      for (const bot of bots) {
        const chats = this._extractChats(bot);
        this._sendJson(ws, { type: 'tg:chats_update', botKey: bot.key, chats });
      }
    } catch (err) {
      this._logger.error?.('[TelegramUIHandler] snapshot error:', err.message);
    }
  }

  /** Maneja el evento tg:open — resetea unreadCount y hace broadcast. */
  _handleOpen(_ws, { botKey, chatId }) {
    if (!this._telegram || !botKey || chatId == null) return;
    try {
      const bot = this._telegram.getBot?.(botKey);
      if (!bot) return;
      const chat = bot.chats?.get(Number(chatId));
      if (chat) chat.unreadCount = 0;
      this._broadcastChatsUpdate(botKey);
    } catch {}
  }

  /** Hace broadcast del estado de chats de un bot específico. */
  _broadcastChatsUpdate(botKey) {
    if (!this._telegram) return;
    try {
      const bot = this._telegram.getBot?.(botKey);
      if (!bot) return;
      const chats = this._extractChats(bot.toJSON ? bot.toJSON() : bot);
      this.broadcast({ type: 'tg:chats_update', botKey, chats });
    } catch {}
  }

  /** Extrae los campos de chat relevantes para la UI. */
  _extractChats(botOrJson) {
    const rawChats = botOrJson.chats || [];
    const arr = Array.isArray(rawChats) ? rawChats : [...rawChats.values()];
    return arr.map(c => ({
      chatId:       c.chatId,
      firstName:    c.firstName || 'Usuario',
      username:     c.username  || null,
      lastPreview:  c.lastPreview  || '',
      lastMessageAt: c.lastMessageAt || 0,
      unreadCount:  c.unreadCount  || 0,
    }));
  }

  _sendJson(ws, obj) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  }
}

module.exports = TelegramUIHandler;
