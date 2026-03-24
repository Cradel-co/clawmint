'use strict';
const express = require('express');

module.exports = function createAgentsRouter({ agents }) {
  const router = express.Router();

  // GET /agents — listar agentes
  router.get('/', (_req, res) => {
    res.json(agents.list());
  });

  // POST /agents — crear agente
  // Body: { key, command?, description?, prompt?, provider? }
  router.post('/', (req, res) => {
    const { key, command, description, prompt, provider } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key requerida' });
    try {
      const agent = agents.add(key, command, description, prompt, provider);
      res.status(201).json(agent);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /agents/:key — actualizar agente
  // Body: { command?, description? }
  router.patch('/:key', (req, res) => {
    try {
      const agent = agents.update(req.params.key, req.body || {});
      res.json(agent);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // DELETE /agents/:key — eliminar agente
  router.delete('/:key', (req, res) => {
    const ok = agents.remove(req.params.key);
    if (!ok) return res.status(404).json({ error: 'Agente no encontrado' });
    res.json({ ok: true });
  });

  return router;
};
