'use strict';

/**
 * routes/typed-memory.js — REST API sobre TypedMemoryRepository.
 *
 * Endpoints:
 *   GET    /api/typed-memory?scope_type=...&scope_id=...&kind=...  — lista
 *   POST   /api/typed-memory                                       — crear
 *   GET    /api/typed-memory/:id                                   — por id
 *   PATCH  /api/typed-memory/:id                                   — update
 *   DELETE /api/typed-memory/:id                                   — remove
 */

const express = require('express');

module.exports = function createTypedMemoryRouter({ typedMemoryRepo, logger } = {}) {
  if (!typedMemoryRepo) throw new Error('typedMemoryRepo requerido');
  const router = express.Router();
  const log = logger || console;

  router.get('/', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const { scope_type, scope_id, kind } = req.query;
      const rows = typedMemoryRepo.list({
        scope_type: scope_type || undefined,
        scope_id: scope_id || undefined,
        kind: kind || undefined,
      });
      res.json(rows);
    } catch (err) {
      log.error && log.error('[typed-memory] list:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const { scope_type, scope_id, kind, name, description, body_path } = req.body || {};
    if (!scope_type || !kind || !name || !body_path) {
      return res.status(400).json({ error: 'scope_type, kind, name y body_path requeridos' });
    }
    try {
      const row = typedMemoryRepo.create({ scope_type, scope_id: scope_id || null, kind, name, description: description || null, body_path });
      res.status(201).json(row);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/:id', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const row = typedMemoryRepo.getById(Number(req.params.id));
      if (!row) return res.status(404).json({ error: 'memory no encontrada' });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const row = typedMemoryRepo.update(Number(req.params.id), req.body || {});
      if (!row) return res.status(404).json({ error: 'memory no encontrada' });
      res.json(row);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const ok = typedMemoryRepo.remove(Number(req.params.id));
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
