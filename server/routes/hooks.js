'use strict';

/**
 * routes/hooks.js — admin CRUD para hooks persistidos.
 *
 * Todas las rutas requieren `requireAdmin` (montar en index.js).
 *
 * GET    /api/hooks              — listar hooks (filtros ?event=&scope_type=&handler_type=&enabled=)
 * GET    /api/hooks/status       — status { enabled, count, executors }
 * POST   /api/hooks              — crear hook + registrar en HookRegistry
 * PATCH  /api/hooks/:id          — actualizar (enable/disable, priority, timeout_ms, etc.)
 * DELETE /api/hooks/:id          — eliminar + unregister
 * POST   /api/hooks/reload       — recargar todos los hooks desde el repo
 */

const express = require('express');

module.exports = function createHooksRouter({ hooksRepo, hookRegistry, hookLoader }) {
  if (!hooksRepo || !hookRegistry) throw new Error('hooksRepo + hookRegistry requeridos');
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json({
      enabled:   hookRegistry.enabled,
      count:     hooksRepo.count(),
      executors: hookRegistry.listExecutorTypes(),
    });
  });

  router.get('/', (req, res) => {
    const filter = {};
    if (req.query.event)        filter.event = String(req.query.event);
    if (req.query.scope_type)   filter.scope_type = String(req.query.scope_type);
    if (req.query.scope_id)     filter.scope_id = String(req.query.scope_id);
    if (req.query.handler_type) filter.handler_type = String(req.query.handler_type);
    if (req.query.enabled !== undefined) filter.enabled = req.query.enabled === 'true' || req.query.enabled === '1';
    res.json(hooksRepo.list(filter));
  });

  router.post('/', (req, res) => {
    try {
      const row = hooksRepo.create(req.body || {});
      if (!row) return res.status(500).json({ error: 'no se pudo crear' });
      // Registrar en registry en runtime (si enabled)
      if (row.enabled && hookLoader) hookLoader.registerHook(row);
      res.status(201).json(row);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    try {
      const row = hooksRepo.update(id, req.body || {});
      if (!row) return res.status(404).json({ error: 'hook no encontrado' });
      // Reflejar cambio en registry: desregistrar + re-registrar si enabled
      if (hookLoader) {
        hookLoader.unregisterHook(id);
        if (row.enabled) hookLoader.registerHook(row);
      }
      res.json(row);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const ok = hooksRepo.remove(id);
    if (!ok) return res.status(404).json({ error: 'hook no encontrado' });
    if (hookLoader) hookLoader.unregisterHook(id);
    res.json({ ok: true });
  });

  router.post('/reload', async (_req, res) => {
    if (!hookLoader) return res.status(503).json({ error: 'hookLoader no disponible' });
    const count = await hookLoader.reload();
    res.json({ ok: true, count });
  });

  return router;
};
