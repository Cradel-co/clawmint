'use strict';

/**
 * routes/permissions.js — CRUD admin para reglas de permisos granulares.
 *
 * Todas las rutas requieren middleware `requireAdmin` (montarlo en index.js).
 *
 * GET    /api/permissions            — listar todas las reglas (filtros ?scope_type=chat&scope_id=X)
 * POST   /api/permissions            — crear regla { scope_type, scope_id?, tool_pattern, action, reason? }
 * DELETE /api/permissions/:id        — eliminar regla
 * GET    /api/permissions/status     — estado del servicio (enabled? count)
 */

const express = require('express');

module.exports = function createPermissionsRouter({ permissionService }) {
  if (!permissionService) throw new Error('permissionService requerido');
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json({
      enabled: permissionService.enabled,
      count: permissionService.count(),
    });
  });

  router.get('/', (req, res) => {
    const filter = {};
    if (req.query.scope_type) filter.scope_type = String(req.query.scope_type);
    if (req.query.scope_id)   filter.scope_id   = String(req.query.scope_id);
    res.json(permissionService.list(filter));
  });

  router.post('/', (req, res) => {
    try {
      const rule = permissionService.create(req.body || {});
      if (!rule) return res.status(500).json({ error: 'No se pudo crear la regla' });
      res.status(201).json(rule);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
    const ok = permissionService.remove(id);
    if (!ok) return res.status(404).json({ error: 'Regla no encontrada' });
    res.json({ ok: true });
  });

  return router;
};
