'use strict';

/**
 * routes/lsp.js — admin-only. Espeja el status de LSPServerManager.
 *
 * Endpoints:
 *   GET  /api/lsp/status              — servers configurados + disponibilidad
 *   POST /api/lsp/detect              — force re-detect de binarios
 *   POST /api/lsp/shutdown            — detener todos los clientes LSP activos
 */

const express = require('express');

module.exports = function createLspRouter({ lspServerManager, usersRepo, logger } = {}) {
  if (!lspServerManager) throw new Error('lspServerManager requerido');
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

  router.get('/status', requireAdmin, (_req, res) => {
    try {
      const servers = typeof lspServerManager.listServers === 'function'
        ? lspServerManager.listServers()
        : [];
      const active = typeof lspServerManager.list === 'function'
        ? lspServerManager.list()
        : [];
      res.json({
        enabled: process.env.LSP_ENABLED === 'true',
        servers,   // config'd servers con availability
        active,    // workspaces activos (pool)
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/detect', requireAdmin, async (_req, res) => {
    try {
      const results = await lspServerManager.detectAvailableServers({ force: true });
      res.json({ ok: true, results });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/shutdown', requireAdmin, async (_req, res) => {
    try {
      await lspServerManager.shutdown();
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
};
