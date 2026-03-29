'use strict';

const express = require('express');

module.exports = function createRemindersRouter({ reminders }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    try {
      res.json({ reminders: reminders.listAll() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', (req, res) => {
    try {
      const { chatId, botKey, text, duration } = req.body || {};
      if (!text || !duration) return res.status(400).json({ error: 'text y duration son requeridos' });

      const durationMs = reminders.parseDuration(duration);
      if (!durationMs) return res.status(400).json({ error: `Duración inválida: ${duration}` });

      const reminder = reminders.add(chatId || 0, botKey || 'web', text, durationMs);
      res.json(reminder);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      const ok = reminders.remove(req.params.id);
      if (!ok) return res.status(404).json({ error: 'Reminder no encontrado' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
