'use strict';
const express = require('express');

module.exports = function createMcpsRouter({ mcps }) {
  const router = express.Router();

  // GET /mcps — listar MCPs configurados
  router.get('/', (_req, res) => {
    res.json(mcps.list());
  });

  // POST /mcps — crear MCP
  router.post('/', (req, res) => {
    try {
      const mcp = mcps.add(req.body);
      res.status(201).json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // PATCH /mcps/:name — actualizar MCP
  router.patch('/:name', (req, res) => {
    try {
      const mcp = mcps.update(req.params.name, req.body);
      res.json(mcp);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  // DELETE /mcps/:name — eliminar MCP
  router.delete('/:name', (req, res) => {
    const ok = mcps.remove(req.params.name);
    if (!ok) return res.status(404).json({ error: 'MCP no encontrado' });
    res.json({ ok: true });
  });

  // POST /mcps/:name/sync — activar MCP (sincronizar con Claude CLI + pool)
  router.post('/:name/sync', async (req, res) => {
    try {
      const mcp = await mcps.sync(req.params.name);
      res.json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /mcps/:name/enable — alias de sync (usado por el frontend)
  router.post('/:name/enable', async (req, res) => {
    try {
      const mcp = await mcps.sync(req.params.name);
      res.json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /mcps/:name/unsync — desactivar MCP
  router.post('/:name/unsync', async (req, res) => {
    try {
      const mcp = await mcps.unsync(req.params.name);
      res.json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /mcps/:name/disable — alias de unsync (usado por el frontend)
  router.post('/:name/disable', async (req, res) => {
    try {
      const mcp = await mcps.unsync(req.params.name);
      res.json(mcp);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // POST /mcps/registry/search — buscar en Smithery
  router.post('/registry/search', async (req, res) => {
    try {
      const results = await mcps.searchSmithery(req.body.query, req.body.limit);
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /mcps/registry/install — instalar desde Smithery
  router.post('/registry/install', async (req, res) => {
    try {
      const result = await mcps.installFromRegistry(req.body.qualifiedName, req.body.name);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
};
