'use strict';
const express = require('express');

module.exports = function createTelegramRouter({ telegram, sessionManager }) {
  const router = express.Router();

  // Helper: verificar que el bot pertenece al usuario (o es interno/sin owner)
  function _ownedBot(req, res) {
    const bot = telegram.getBot(req.params.key);
    if (!bot) { res.status(404).json({ error: 'Bot no encontrado' }); return null; }
    if (req.user.internal) return bot;
    if (!bot.ownerId) return bot; // bots sin owner → acceso libre
    if (bot.ownerId !== req.user.id) {
      res.status(403).json({ error: 'No tenés acceso a este bot' });
      return null;
    }
    return bot;
  }

  // GET /telegram/mode — modo actual (polling|webhook) y URL de webhook
  router.get('/mode', (_req, res) => {
    res.json({
      mode:       telegram._telegramMode || 'polling',
      webhookUrl: telegram._webhookBaseUrl || '',
    });
  });

  // GET /telegram/bots — lista bots del usuario autenticado
  router.get('/bots', (req, res) => {
    if (req.user.internal) return res.json(telegram.listBots());
    res.json(telegram.listBotsByOwner(req.user.id));
  });

  // POST /telegram/bots — agregar bot (asignado al usuario)
  // Body: { key, token }
  router.post('/bots', async (req, res) => {
    const { key, token } = req.body || {};
    if (!key || !token) return res.status(400).json({ error: 'key y token requeridos' });
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) return res.status(400).json({ error: 'key inválida (solo letras, números, _ y -)' });
    try {
      const result = await telegram.addBot(key, token, { ownerId: req.user.id });
      res.json({ ok: true, username: result.username });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /telegram/bots/:key/claim — reclamar bot sin owner
  router.post('/bots/:key/claim', (req, res) => {
    const bot = telegram.getBot(req.params.key);
    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    if (bot.ownerId && bot.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Este bot ya tiene dueño' });
    }
    bot.ownerId = req.user.id;
    telegram.saveBots();
    res.json({ ok: true, ownerId: req.user.id });
  });

  // DELETE /telegram/bots/:key — eliminar bot (solo owner)
  router.delete('/bots/:key', async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    await telegram.removeBot(req.params.key);
    res.json({ ok: true });
  });

  // POST /telegram/bots/:key/start — iniciar bot (solo owner)
  router.post('/bots/:key/start', async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    try {
      const result = await telegram.startBot(req.params.key);
      res.json({ ok: true, username: result.username });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /telegram/bots/:key — actualizar config del bot (solo owner)
  // Body: { defaultAgent?, whitelist?, groupWhitelist?, rateLimit?, rateLimitKeyword? }
  router.patch('/bots/:key', (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    const { defaultAgent, whitelist, groupWhitelist, rateLimit, rateLimitKeyword } = req.body || {};
    if (defaultAgent !== undefined) bot.setDefaultAgent(defaultAgent);
    if (whitelist !== undefined) bot.setWhitelist(whitelist);
    if (groupWhitelist !== undefined) bot.setGroupWhitelist(groupWhitelist);
    if (rateLimit !== undefined) bot.setRateLimit(rateLimit);
    if (rateLimitKeyword !== undefined) bot.setRateLimitKeyword(rateLimitKeyword);
    telegram.saveBots();
    res.json(bot.toJSON());
  });

  // POST /telegram/bots/:key/stop — detener bot (solo owner)
  router.post('/bots/:key/stop', async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    try {
      await telegram.stopBot(req.params.key);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /telegram/bots/:key/chats — chats del bot (solo owner)
  router.get('/bots/:key/chats', (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    res.json([...bot.chats.values()]);
  });

  // POST /telegram/bots/:key/chats/:chatId/session — vincular sesión (solo owner)
  // Body: { sessionId? } — omitir → crear nueva claude
  router.post('/bots/:key/chats/:chatId/session', async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    const { key } = req.params;
    const chatId = Number(req.params.chatId);
    const { sessionId } = req.body || {};

    if (sessionId) {
      const ok = telegram.linkSession(key, chatId, sessionId);
      if (!ok) return res.status(404).json({ error: 'Chat o bot no encontrado' });
      return res.json({ ok: true, sessionId });
    }

    const session = sessionManager.create({ type: 'pty', command: 'claude', cols: 80, rows: 24 });
    telegram.linkSession(key, chatId, session.id);
    res.json({ ok: true, sessionId: session.id });
  });

  // DELETE /telegram/bots/:key/chats/:chatId — desconectar chat (solo owner)
  router.delete('/bots/:key/chats/:chatId', (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    const ok = telegram.disconnectChat(req.params.key, Number(req.params.chatId));
    res.json({ ok });
  });

  // POST /telegram/bots/:key/chats/:chatId/message — enviar texto a un chat (solo owner o interno)
  router.post('/bots/:key/chats/:chatId/message', async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    try {
      const chatId = Number(req.params.chatId);
      const { text, parse_mode, reply_markup, callbacks } = req.body || {};
      if (!text) return res.status(400).json({ error: 'Se requiere text' });

      // Registrar callbacks dinámicos si vienen
      if (callbacks && typeof callbacks === 'object') {
        const dynamicRegistry = require('../channels/telegram/DynamicCallbackRegistry');
        dynamicRegistry.registerMany(callbacks);
      }

      const body = { chat_id: chatId, text };
      if (parse_mode) body.parse_mode = parse_mode;
      if (reply_markup) body.reply_markup = typeof reply_markup === 'string' ? reply_markup : JSON.stringify(reply_markup);
      const result = await bot._apiCall('sendMessage', body);
      res.json({ ok: true, message_id: result.message_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /telegram/bots/:key/chats/:chatId/photo — enviar imagen a un chat (solo owner o interno)
  router.post('/bots/:key/chats/:chatId/photo', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    try {
      const chatId = Number(req.params.chatId);
      const caption = req.query.caption || '';
      const filename = req.query.filename || 'photo.png';

      let photoBuffer;
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        photoBuffer = req.body;
      } else if (typeof req.body === 'string') {
        photoBuffer = Buffer.from(req.body, 'base64');
      } else {
        return res.status(400).json({ error: 'Se requiere imagen como body raw o base64' });
      }

      const result = await bot.sendPhoto(chatId, photoBuffer, { caption, filename });
      res.json({ ok: true, message_id: result.message_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /telegram/bots/:key/chats/:chatId/document — enviar archivo a un chat (solo owner o interno)
  router.post('/bots/:key/chats/:chatId/document', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    try {
      const chatId = Number(req.params.chatId);
      const caption = req.query.caption || '';
      const filename = req.query.filename || 'file.bin';
      const contentType = req.query.contentType || 'application/octet-stream';

      let docBuffer;
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        docBuffer = req.body;
      } else if (typeof req.body === 'string') {
        docBuffer = Buffer.from(req.body, 'base64');
      } else {
        return res.status(400).json({ error: 'Se requiere archivo como body raw o base64' });
      }

      const result = await bot.sendDocument(chatId, docBuffer, { caption, filename, contentType });
      res.json({ ok: true, message_id: result.message_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /telegram/bots/:key/chats/:chatId/voice — enviar audio/voz a un chat (solo owner o interno)
  router.post('/bots/:key/chats/:chatId/voice', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    try {
      const chatId = Number(req.params.chatId);

      let audioBuffer;
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        audioBuffer = req.body;
      } else if (typeof req.body === 'string') {
        audioBuffer = Buffer.from(req.body, 'base64');
      } else {
        return res.status(400).json({ error: 'Se requiere audio como body raw o base64' });
      }

      const result = await bot.sendVoice(chatId, audioBuffer);
      res.json({ ok: true, message_id: result.message_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /telegram/bots/:key/chats/:chatId/video — enviar video a un chat (solo owner o interno)
  router.post('/bots/:key/chats/:chatId/video', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    try {
      const chatId = Number(req.params.chatId);
      const caption = req.query.caption || '';
      const filename = req.query.filename || 'video.mp4';

      let videoBuffer;
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        videoBuffer = req.body;
      } else if (typeof req.body === 'string') {
        videoBuffer = Buffer.from(req.body, 'base64');
      } else {
        return res.status(400).json({ error: 'Se requiere video como body raw o base64' });
      }

      const result = await bot.sendVideo(chatId, videoBuffer, { caption, filename });
      res.json({ ok: true, message_id: result.message_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /telegram/bots/:key/chats/:chatId/edit — editar mensaje de texto (solo owner o interno)
  router.post('/bots/:key/chats/:chatId/edit', async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    try {
      const chatId = Number(req.params.chatId);
      const { message_id, text, parse_mode } = req.body || {};
      if (!message_id || !text) return res.status(400).json({ error: 'Se requieren message_id y text' });

      const body = { chat_id: chatId, message_id, text };
      if (parse_mode) body.parse_mode = parse_mode;
      const result = await bot._apiCall('editMessageText', body);
      res.json({ ok: true, message_id: result.message_id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /telegram/bots/:key/chats/:chatId/delete — borrar mensaje (solo owner o interno)
  router.post('/bots/:key/chats/:chatId/delete', async (req, res) => {
    const bot = _ownedBot(req, res);
    if (!bot) return;
    try {
      const chatId = Number(req.params.chatId);
      const { message_id } = req.body || {};
      if (!message_id) return res.status(400).json({ error: 'Se requiere message_id' });

      await bot._apiCall('deleteMessage', { chat_id: chatId, message_id });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
