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
   * @param {{ telegram: object, authService?: object, logger?: object }} opts
   */
  constructor({ telegram, authService = null, logger = console }) {
    this._telegram    = telegram;
    this._authService = authService;
    this._logger      = logger;
    /** @type {Set<import('ws').WebSocket>} */
    this._clients     = new Set();
    /** @type {Map<import('ws').WebSocket, string>} ws → userId */
    this._clientUsers = new Map();
  }

  /**
   * Llamado desde pty-handler.js cuando sessionType === 'telegram-ui'.
   * @param {import('ws').WebSocket} ws
   * @param {object} [opts]  — contiene opts.jwt si el cliente lo envió
   */
  handleConnection(ws, opts = {}) {
    let userId = null;
    if (this._authService) {
      const payload = this._authService.verifyAccessToken(opts.jwt);
      if (!payload) {
        this._sendJson(ws, { type: 'auth_error', error: 'Token inválido o expirado', code: 'TOKEN_EXPIRED' });
        ws.close(4001, 'Unauthorized');
        return;
      }
      userId = payload.sub;
    }
    this._clients.add(ws);
    if (userId) this._clientUsers.set(ws, userId);

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
      this._clientUsers.delete(ws);
    });
  }

  /**
   * Llamado desde EventBus cuando llega un mensaje al bot.
   * @param {{ botKey: string, chatId: number, role: string, text: string, ts: number, tgMsgId?: number, chat: object }} data
   */
  notifyNewMessage({ botKey, chatId, role, text, ts, tgMsgId, chat }) {
    const ownerId = this._telegram?.getBot?.(botKey)?.ownerId || null;
    const message = { role, text, ts, tgMsgId: tgMsgId || null };
    this.broadcast({ type: 'tg:message', botKey, chatId, message }, ownerId);
    this._broadcastChatsUpdate(botKey);
  }

  /**
   * Envía un evento a los clientes WS conectados.
   * @param {object} event
   * @param {string|null} [ownerId]  — si se indica, solo envía al cliente dueño del bot
   */
  broadcast(event, ownerId = null) {
    const json = JSON.stringify(event);
    for (const ws of this._clients) {
      if (ws.readyState !== ws.OPEN) continue;
      // Si el evento tiene dueño, solo enviarlo al cliente que corresponde
      if (ownerId) {
        const clientUser = this._clientUsers.get(ws);
        if (clientUser && clientUser !== ownerId) continue;
      }
      try { ws.send(json); } catch {}
    }
  }

  // ── Privado ────────────────────────────────────────────────────────────────

  /** Envía snapshot de los bots del usuario conectado. */
  _sendSnapshot(ws) {
    if (!this._telegram) return;
    try {
      const userId = this._clientUsers.get(ws);
      const bots = this._telegram.listBots ? this._telegram.listBots() : [];
      for (const bot of bots) {
        // Bots sin ownerId son legado — visibles a todos; con ownerId solo al dueño
        if (bot.ownerId && userId && bot.ownerId !== userId) continue;
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
      this.broadcast({ type: 'tg:chats_update', botKey, chats }, bot.ownerId || null);
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
