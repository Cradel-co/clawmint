'use strict';
const express = require('express');

module.exports = function createAgentsRouter({ agents }) {
  const router = express.Router();

  // GET /agents — listar agentes (globales + propios del usuario)
  router.get('/', (req, res) => {
    const userId = req.user?.internal ? null : req.user?.id;
    res.json(agents.list(userId));
  });

  // POST /agents — crear agente (se asigna al usuario autenticado)
  // Body: { key, command?, description?, prompt?, provider? }
  router.post('/', (req, res) => {
    const { key, command, description, prompt, provider } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key requerida' });
    const userId = req.user?.internal ? null : req.user?.id;
    try {
      const agent = agents.add(key, command, description, prompt, provider, userId);
      res.status(201).json(agent);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PATCH /agents/:key — actualizar agente (solo el dueño puede editar los privados)
  // Body: { command?, description? }
  router.patch('/:key', (req, res) => {
    const userId = req.user?.internal ? null : req.user?.id;
    try {
      const agent = agents.update(req.params.key, req.body || {}, userId);
      res.json(agent);
    } catch (err) {
      const status = err.message.includes('permisos') ? 403 : 404;
      res.status(status).json({ error: err.message });
    }
  });

  // DELETE /agents/:key — eliminar agente (solo el dueño puede borrar los privados)
  router.delete('/:key', (req, res) => {
    const userId = req.user?.internal ? null : req.user?.id;
    const ok = agents.remove(req.params.key, userId);
    if (!ok) return res.status(404).json({ error: 'Agente no encontrado o sin permisos' });
    res.json({ ok: true });
  });

  return router;
};
