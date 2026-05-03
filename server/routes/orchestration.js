'use strict';

/**
 * routes/orchestration.js — admin-only. Muestra workflows activos y permite
 * cancelarlos. Consume AgentOrchestrator inyectado.
 *
 * Endpoints:
 *   GET  /api/orchestration/workflows           — lista workflows + tasks
 *   POST /api/orchestration/workflows/:id/cancel — cancela workflow en curso
 */

const express = require('express');

module.exports = function createOrchestrationRouter({ orchestrator, usersRepo, logger } = {}) {
  if (!orchestrator) throw new Error('orchestrator requerido');
  const router = express.Router();
  const log = logger || console;

  function requireAdmin(req, res, next) {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const u = usersRepo?.getById?.(req.user.id);
      if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado — solo administradores' });
      next();
    } catch (err) { res.status(500).json({ error: err.message }); }
  }

  router.get('/workflows', requireAdmin, (_req, res) => {
    try {
      const list = typeof orchestrator.listWorkflows === 'function'
        ? orchestrator.listWorkflows()
        : [];
      res.json(list);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/workflows/:id/cancel', requireAdmin, (req, res) => {
    try {
      const ok = typeof orchestrator.cancelWorkflow === 'function'
        ? orchestrator.cancelWorkflow(req.params.id)
        : false;
      if (!ok) return res.status(404).json({ error: 'workflow no encontrado' });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
