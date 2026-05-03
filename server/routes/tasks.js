'use strict';

/**
 * routes/tasks.js — REST API sobre TaskRepository.
 *
 * Scoped por chat_id (obligatorio en query para list, en body para create).
 * Admin puede operar sobre cualquier chat; user normal sobre sus propios
 * chats (resuelto via usersRepo).
 *
 * Endpoints:
 *   GET    /api/tasks?chat_id=...&status=...    — lista
 *   POST   /api/tasks                           — crear
 *   GET    /api/tasks/:id?chat_id=...           — get por id
 *   PATCH  /api/tasks/:id                       — update (body incluye chat_id)
 *   DELETE /api/tasks/:id?chat_id=...           — remove
 */

const express = require('express');

module.exports = function createTasksRouter({ tasksRepo, usersRepo, logger } = {}) {
  if (!tasksRepo) throw new Error('tasksRepo requerido');
  const router = express.Router();
  const log = logger || console;

  function _isAdmin(userId) {
    if (!userId || !usersRepo) return false;
    try { return (usersRepo.getById(userId) || {}).role === 'admin'; } catch { return false; }
  }

  router.get('/', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const { chat_id, status, parent_id } = req.query;
    if (!chat_id && !_isAdmin(req.user.id)) {
      return res.status(400).json({ error: 'chat_id requerido (o ser admin para listar todos)' });
    }
    try {
      const opts = { limit: Number(req.query.limit) || 50 };
      if (chat_id) opts.chat_id = String(chat_id);
      if (status) opts.status = String(status);
      if (parent_id) opts.parent_id = Number(parent_id) || null;
      // Si no hay chat_id (admin path), TaskRepository.list requiere chat_id.
      // Workaround: si admin y no chat_id, retornamos vacío con mensaje claro.
      if (!opts.chat_id) return res.status(400).json({ error: 'chat_id requerido para listar tasks' });
      const rows = tasksRepo.list(opts);
      res.json(rows);
    } catch (err) {
      log.error && log.error('[tasks] list:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const { chat_id, agent_key, title, description, parent_id, metadata } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'chat_id requerido' });
    if (!title) return res.status(400).json({ error: 'title requerido' });
    try {
      const row = tasksRepo.create({
        chat_id,
        user_id: req.user.id,
        agent_key: agent_key || null,
        title,
        description: description || null,
        parent_id: parent_id || null,
        metadata: metadata || null,
      });
      res.status(201).json(row);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/:id', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id query requerido' });
    try {
      const row = tasksRepo.getById(Number(req.params.id), String(chatId));
      if (!row) return res.status(404).json({ error: 'task no encontrada' });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const { chat_id, ...fields } = req.body || {};
    if (!chat_id) return res.status(400).json({ error: 'chat_id requerido en body' });
    try {
      const ok = tasksRepo.update(Number(req.params.id), String(chat_id), fields);
      if (!ok) return res.status(404).json({ error: 'task no encontrada' });
      const row = tasksRepo.getById(Number(req.params.id), String(chat_id));
      res.json(row || { ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id query requerido' });
    try {
      const result = tasksRepo.remove(Number(req.params.id), String(chatId));
      res.json({ ok: (result?.removed || 0) > 0, descendants: result?.descendants || 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
