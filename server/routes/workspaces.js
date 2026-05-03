'use strict';

/**
 * routes/workspaces.js — admin-only. Espeja el contenido del tool
 * `workspace_status` vía HTTP para que el cliente lo consuma sin tener que
 * invocar tools MCP.
 *
 * Endpoints:
 *   GET /api/workspaces          — lista workspaces activos por provider
 *   DELETE /api/workspaces/:id   — release de un workspace específico (por id,
 *                                  se busca en todos los providers)
 */

const express = require('express');

module.exports = function createWorkspacesRouter({ workspaceRegistry, usersRepo, logger } = {}) {
  if (!workspaceRegistry) throw new Error('workspaceRegistry requerido');
  if (!usersRepo) throw new Error('usersRepo requerido');
  const router = express.Router();
  const log = logger || console;

  function requireAdmin(req, res, next) {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const u = usersRepo.getById(req.user.id);
      if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado — solo administradores' });
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  router.get('/', requireAdmin, (_req, res) => {
    const result = {};
    for (const [providerName, provider] of Object.entries(workspaceRegistry)) {
      if (!provider) { result[providerName] = { enabled: false, workspaces: [] }; continue; }
      if (typeof provider.list === 'function') {
        try {
          result[providerName] = { enabled: true, workspaces: provider.list() };
        } catch (err) {
          result[providerName] = { enabled: true, error: err.message, workspaces: [] };
        }
      } else {
        result[providerName] = { enabled: true, workspaces: [] };
      }
    }
    res.json(result);
  });

  router.delete('/:id', requireAdmin, async (req, res) => {
    const target = req.params.id;
    for (const [providerName, provider] of Object.entries(workspaceRegistry)) {
      if (!provider || typeof provider.list !== 'function') continue;
      try {
        const list = provider.list();
        const entry = list.find(e => e.id === target);
        if (!entry) continue;
        // Cada provider tiene su propio release (handle retornado por acquire).
        // Como no persistimos handles acá, buscamos un método release(id) si existe.
        if (typeof provider.releaseById === 'function') {
          await provider.releaseById(target);
          return res.json({ ok: true, provider: providerName, id: target });
        }
        // Fallback: Git worktree tiene `_removeWorktree` internal; Docker/SSH
        // idem. Sin API pública, devolvemos hint al admin.
        return res.status(501).json({
          error: `Release manual requerido para provider "${providerName}". Esta operación no expone una API segura todavía.`,
          provider: providerName, id: target,
        });
      } catch (err) {
        log.warn && log.warn(`[workspaces] release ${target} en ${providerName} falló: ${err.message}`);
      }
    }
    res.status(404).json({ error: `Workspace "${target}" no encontrado en ningún provider` });
  });

  return router;
};
