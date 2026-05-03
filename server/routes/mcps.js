'use strict';
const express = require('express');

/**
 * Router /api/mcps.
 *
 * GET es libre para cualquier usuario autenticado (devuelve lista con secrets
 * censurados — útil para paneles de Integraciones/Dispositivos/Música que
 * solo necesitan saber qué hay configurado).
 *
 * POST/PATCH/DELETE + registry requieren admin porque pueden ejecutar
 * comandos arbitrarios al agregar MCPs. El caller pasa el middleware.
 */
module.exports = function createMcpsRouter({ mcps, requireAdmin }) {
  const router = express.Router();
  const adminOnly = requireAdmin || ((_req, _res, next) => next());

  // GET /mcps — listar MCPs configurados (env censurado) — cualquier user auth
  router.get('/', (_req, res) => {
    const list = mcps.list().map(m => {
      const safe = { ...m };
      if (safe.env) {
        safe.env = Object.fromEntries(
          Object.entries(safe.env).map(([k, v]) =>
            [k, typeof v === 'string' && v.length > 8 ? v.slice(0, 8) + '…' : '***']
          )
        );
      }
      if (safe.headers) {
        safe.headers = Object.fromEntries(
          Object.entries(safe.headers).map(([k, v]) =>
            [k, typeof v === 'string' && v.length > 8 ? v.slice(0, 8) + '…' : '***']
          )
        );
      }
      return safe;
    });
    res.json(list);
  });

  // POST /mcps — crear MCP (admin)
  router.post('/', adminOnly, (req, res) => {
    try {
      const mcp = mcps.add(req.body);
      res.status(201).json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // PATCH /mcps/:name — actualizar MCP (admin)
  router.patch('/:name', adminOnly, (req, res) => {
    try {
      const mcp = mcps.update(req.params.name, req.body);
      res.json(mcp);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  // DELETE /mcps/:name — eliminar MCP (admin)
  router.delete('/:name', adminOnly, (req, res) => {
    const ok = mcps.remove(req.params.name);
    if (!ok) return res.status(404).json({ error: 'MCP no encontrado' });
    res.json({ ok: true });
  });

  // POST /mcps/:name/sync — activar MCP (sincronizar con Claude CLI + pool) (admin)
  router.post('/:name/sync', adminOnly, async (req, res) => {
    try {
      const mcp = await mcps.sync(req.params.name);
      res.json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /mcps/:name/enable — alias de sync (admin)
  router.post('/:name/enable', adminOnly, async (req, res) => {
    try {
      const mcp = await mcps.sync(req.params.name);
      res.json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /mcps/:name/unsync — desactivar MCP (admin)
  router.post('/:name/unsync', adminOnly, async (req, res) => {
    try {
      const mcp = await mcps.unsync(req.params.name);
      res.json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /mcps/:name/disable — alias de unsync (admin)
  router.post('/:name/disable', adminOnly, async (req, res) => {
    try {
      const mcp = await mcps.unsync(req.params.name);
      res.json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /mcps/registry/search — buscar en Smithery (admin)
  router.post('/registry/search', adminOnly, async (req, res) => {
    try {
      const results = await mcps.searchSmithery(req.body.query, req.body.limit);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /mcps/registry/install — instalar desde Smithery (admin)
  router.post('/registry/install', adminOnly, async (req, res) => {
    try {
      const result = await mcps.installFromRegistry(req.body.qualifiedName, req.body.name);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
};
