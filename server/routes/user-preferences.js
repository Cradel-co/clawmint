'use strict';

/**
 * routes/user-preferences.js — API REST per-user para preferences (keybindings,
 * statusline, layout). Requiere `requireAuth` — cada usuario maneja SOLO sus
 * propias preferences (no admin-only).
 *
 * Endpoints:
 *   GET    /api/user-preferences              — lista todas las preferences del user
 *   GET    /api/user-preferences/:key         — get una específica
 *   PUT    /api/user-preferences/:key         — upsert; body: { value }
 *   DELETE /api/user-preferences/:key         — remove
 */

const express = require('express');

module.exports = function createUserPreferencesRouter({ userPreferencesRepo }) {
  if (!userPreferencesRepo) throw new Error('userPreferencesRepo requerido');
  const router = express.Router();

  router.get('/', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    res.json(userPreferencesRepo.listByUser(req.user.id));
  });

  router.get('/:key', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const v = userPreferencesRepo.get(req.user.id, req.params.key);
    if (v === null) return res.status(404).json({ error: 'preference no encontrada' });
    res.json({ key: req.params.key, value: v });
  });

  router.put('/:key', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    if (!req.body || !('value' in req.body)) return res.status(400).json({ error: 'body requiere { value }' });
    try {
      const v = userPreferencesRepo.set(req.user.id, req.params.key, req.body.value);
      res.json({ key: req.params.key, value: v });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:key', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const ok = userPreferencesRepo.remove(req.user.id, req.params.key);
    if (!ok) return res.status(404).json({ error: 'preference no encontrada' });
    res.json({ ok: true });
  });

  return router;
};
