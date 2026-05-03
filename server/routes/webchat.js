'use strict';
const express = require('express');

module.exports = function createWebchatRouter({ webChannel, authService }) {
  const router = express.Router();

  // Helper: extrae user_id del JWT si vino. No bloquea — solo lo usa para filtrar.
  function getUserId(req) {
    if (!authService) return null;
    const auth = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return null;
    try {
      const payload = authService.verifyAccessToken(m[1]);
      return payload?.sub || null;
    } catch { return null; }
  }

  // GET /webchat/sessions — listar sesiones activas
  router.get('/sessions', (_req, res) => {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    res.json(webChannel.listSessions());
  });

  // GET /webchat/history — historial de sesiones pasadas (filtrado por user)
  router.get('/history', (req, res) => {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const userId = getUserId(req);
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    res.json({ sessions: webChannel.listSessionHistory({ userId, includeArchived }) });
  });

  // GET /webchat/search?q=X — full-text search en mensajes y títulos
  router.get('/search', (req, res) => {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const q = (req.query.q || '').toString();
    if (!q.trim()) return res.json({ results: [] });
    const userId = getUserId(req);
    const results = webChannel.searchSessions(q, { userId, limit: 50 });
    res.json({ results });
  });

  // PATCH /webchat/sessions/:id — renombrar / pin / archivar / share
  // Body: { title?, pinned?, archived?, share_scope? }
  router.patch('/sessions/:id', express.json(), (req, res) => {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const { id } = req.params;
    const body = req.body || {};
    const fields = {};
    if (typeof body.title === 'string')      fields.title = body.title.trim().slice(0, 200) || null;
    if (typeof body.pinned === 'boolean')    fields.pinned = body.pinned ? 1 : 0;
    if (typeof body.archived === 'boolean')  fields.archived = body.archived ? 1 : 0;
    if (body.share_scope === 'household' || body.share_scope === 'user') {
      fields.share_scope = body.share_scope;
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'Sin campos para actualizar' });
    webChannel.updateSessionMeta(id, fields);
    res.json({ ok: true, fields });
  });

  // DELETE /webchat/sessions/:id — borrado duro (mensajes + meta + chat_settings)
  router.delete('/sessions/:id', (req, res) => {
    if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
    const { id } = req.params;
    const ok = webChannel.deleteSession(id);
    res.json({ ok });
  });

  // POST /webchat/sessions/:sessionId/message — enviar texto a una sesión
  router.post('/sessions/:sessionId/message', async (req, res) => {
    try {
      if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
      const { sessionId } = req.params;
      const { text, buttons, callbacks } = req.body || {};
      if (!text) return res.status(400).json({ error: 'Se requiere text' });

      // Registrar callbacks dinámicos si vienen
      if (callbacks && typeof callbacks === 'object') {
        const dynamicRegistry = require('../channels/telegram/DynamicCallbackRegistry');
        dynamicRegistry.registerMany(callbacks);
      }

      if (buttons) {
        await webChannel.sendWithButtons(sessionId, text, buttons);
      } else {
        await webChannel.sendText(sessionId, text);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /webchat/sessions/:sessionId/photo — enviar imagen a una sesión
  router.post('/sessions/:sessionId/photo', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
    try {
      if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
      const { sessionId } = req.params;
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

      const base64 = photoBuffer.toString('base64');
      const mimeType = req.headers['content-type'] || 'image/png';
      const msgId = await webChannel.sendPhoto(sessionId, base64, { caption, filename, mimeType });
      res.json({ ok: true, msgId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /webchat/sessions/:sessionId/document — enviar archivo a una sesión
  router.post('/sessions/:sessionId/document', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    try {
      if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
      const { sessionId } = req.params;
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

      const base64 = docBuffer.toString('base64');
      const msgId = await webChannel.sendDocument(sessionId, base64, { caption, filename, mimeType: contentType });
      res.json({ ok: true, msgId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /webchat/sessions/:sessionId/edit — editar mensaje
  router.post('/sessions/:sessionId/edit', async (req, res) => {
    try {
      if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
      const { sessionId } = req.params;
      const { msg_id, text } = req.body || {};
      if (!msg_id || !text) return res.status(400).json({ error: 'Se requieren msg_id y text' });
      await webChannel.editMessage(sessionId, msg_id, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /webchat/sessions/:sessionId/delete — borrar mensaje
  router.post('/sessions/:sessionId/delete', async (req, res) => {
    try {
      if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
      const { sessionId } = req.params;
      const { msg_id } = req.body || {};
      if (!msg_id) return res.status(400).json({ error: 'Se requiere msg_id' });
      await webChannel.deleteMessage(sessionId, msg_id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /webchat/sessions/:sessionId/voice — enviar audio a una sesión
  router.post('/sessions/:sessionId/voice', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
    try {
      if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
      const { sessionId } = req.params;
      const caption = req.query.caption || '';
      const filename = req.query.filename || 'audio.ogg';

      let audioBuffer;
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        audioBuffer = req.body;
      } else if (typeof req.body === 'string') {
        audioBuffer = Buffer.from(req.body, 'base64');
      } else {
        return res.status(400).json({ error: 'Se requiere audio como body raw o base64' });
      }

      const base64 = audioBuffer.toString('base64');
      const mimeType = req.headers['content-type'] || 'audio/ogg';
      const msgId = await webChannel.sendVoice(sessionId, base64, { caption, filename, mimeType });
      res.json({ ok: true, msgId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /webchat/sessions/:sessionId/video — enviar video a una sesión
  router.post('/sessions/:sessionId/video', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    try {
      if (!webChannel) return res.status(503).json({ error: 'WebChannel no disponible' });
      const { sessionId } = req.params;
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

      const base64 = videoBuffer.toString('base64');
      const mimeType = req.headers['content-type'] || 'video/mp4';
      const msgId = await webChannel.sendVideo(sessionId, base64, { caption, filename, mimeType });
      res.json({ ok: true, msgId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
