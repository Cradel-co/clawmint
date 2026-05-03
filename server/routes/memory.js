'use strict';
const express = require('express');

module.exports = function createMemoryRouter({ memory }) {
  const router = express.Router();

  // GET /memory/debug?agentKey=xxx — análisis completo del estado de memoria
  router.get('/debug', (req, res) => {
    const agentKey = req.query.agentKey || null;

    // Stats desde SQLite
    const graph  = memory.buildGraph(agentKey);
    const notes  = graph.nodes;
    const links  = graph.links;

    // Distribución de importancia
    const byImportance = {};
    for (const n of notes) {
      byImportance[n.importance] = (byImportance[n.importance] || 0) + 1;
    }

    // Top 10 notas más accedidas
    const topAccessed = [...notes]
      .sort((a, b) => b.accessCount - a.accessCount)
      .slice(0, 10)
      .map(n => ({ id: n.id, title: n.title, tags: n.tags, accessCount: n.accessCount, importance: n.importance }));

    // Links learned vs explicit
    const learnedLinks   = links.filter(l => l.type === 'learned');
    const explicitLinks  = links.filter(l => l.type === 'explicit');

    // Top conexiones más fuertes
    const topLinks = [...links]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10)
      .map(l => {
        const src = notes.find(n => n.id === l.source);
        const tgt = notes.find(n => n.id === l.target);
        return {
          from: src?.title || l.source,
          to:   tgt?.title || l.target,
          weight: l.weight,
          type: l.type,
        };
      });

    // Todos los tags únicos
    const allTags = [...new Set(notes.flatMap(n => n.tags))].sort();

    res.json({
      stats: {
        totalNotes:     notes.length,
        totalLinks:     links.length,
        learnedLinks:   learnedLinks.length,
        explicitLinks:  explicitLinks.length,
        uniqueTags:     allTags.length,
        byImportance,
      },
      topAccessed,
      topLinks,
      allTags,
      agentKey: agentKey || '(todos)',
    });
  });

  // GET /memory/graph?agentKey=xxx — grafo para visualización (agentKey opcional; sin él = todos)
  router.get('/graph', (req, res) => {
    const agentKey = req.query.agentKey || null;
    res.json(memory.buildGraph(agentKey));
  });

  // GET /memory/search?q=texto — búsqueda de texto libre global (todos los agentes)
  router.get('/search', (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const results = memory.globalSearch(q);
    res.json(results);
  });

  // GET /memory/:agentKey/search?tags=auth,jwt&q=texto — búsqueda semántica
  router.get('/:agentKey/search', (req, res) => {
    const { agentKey } = req.params;
    const tags    = req.query.tags ? req.query.tags.split(',').map(t => t.trim()) : [];
    const words   = req.query.q   ? memory.extractKeywords(req.query.q)           : [];
    const keywords = [...new Set([...tags, ...words])];
    const results  = memory.spreadingActivation(agentKey, keywords);
    res.json(results.map(r => ({
      filename:    r.filename,
      title:       r.title,
      tags:        r.tags,
      importance:  r.importance,
      accessCount: r.accessCount,
      preview:     r.content.slice(0, 200),
      score:       r.score,
    })));
  });

  // GET /memory/:agentKey — listar archivos de memoria del agente
  router.get('/:agentKey', (req, res) => {
    res.json(memory.listFiles(req.params.agentKey));
  });

  // GET /memory/:agentKey/:filename — leer archivo
  router.get('/:agentKey/:filename', (req, res) => {
    const content = memory.read(req.params.agentKey, req.params.filename);
    if (content === null) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.json({ content });
  });

  // PUT /memory/:agentKey/:filename — escribir/reemplazar archivo
  router.put('/:agentKey/:filename', (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content requerido' });
    try {
      memory.write(req.params.agentKey, req.params.filename, content);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /memory/:agentKey/:filename/append — agregar al final
  router.post('/:agentKey/:filename/append', (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content requerido' });
    try {
      memory.append(req.params.agentKey, req.params.filename, content);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /memory/:agentKey/:filename — eliminar archivo
  router.delete('/:agentKey/:filename', (req, res) => {
    try {
      const ok = memory.remove(req.params.agentKey, req.params.filename);
      if (!ok) return res.status(404).json({ error: 'Archivo no encontrado' });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
