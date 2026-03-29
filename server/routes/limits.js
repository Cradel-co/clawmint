'use strict';
const express = require('express');

module.exports = function createLimitsRouter({ limitsRepo }) {
  const router = express.Router();

  // GET /limits — listar reglas (filtros opcionales: ?type=rate&scope=bot)
  router.get('/', (req, res) => {
    const filters = {};
    if (req.query.type) filters.type = req.query.type;
    if (req.query.scope) filters.scope = req.query.scope;
    res.json(limitsRepo.list(filters));
  });

  // POST /limits — crear regla
  router.post('/', (req, res) => {
    try {
      const rule = limitsRepo.create(req.body);
      res.status(201).json(rule);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /limits/:id — editar regla
  router.patch('/:id', (req, res) => {
    const rule = limitsRepo.update(Number(req.params.id), req.body);
    if (!rule) return res.status(404).json({ error: 'Regla no encontrada' });
    res.json(rule);
  });

  // DELETE /limits/:id — eliminar regla
  router.delete('/:id', (req, res) => {
    const ok = limitsRepo.remove(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Regla no encontrada' });
    res.json({ ok: true });
  });

  return router;
};
