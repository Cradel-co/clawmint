'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createSkillsRouter({ skills }) {
  const router = express.Router();

  // GET /skills — lista skills instalados
  router.get('/', (_req, res) => res.json(skills.listSkills()));

  // POST /skills/install — descarga un skill directamente desde clawhub.ai API
  router.post('/install', async (req, res) => {
    const { slug } = req.body || {};
    if (!slug || !/^[a-z0-9_-]+$/.test(slug))
      return res.status(400).json({ error: 'slug inválido' });
    try {
      const response = await fetch(`https://clawhub.ai/api/v1/skills/${slug}/file?path=SKILL.md`);
      if (!response.ok) throw new Error(`ClawHub respondió ${response.status}`);
      const content = await response.text();
      const dir = path.join(skills.SKILLS_DIR, slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
      res.json({ ok: true, slug });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /skills/search?q=query — buscar skills en ClawHub
  router.get('/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });
    try {
      const results = await skills.searchClawHub(q);
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /skills/:slug — elimina un skill instalado
  router.delete('/:slug', (req, res) => {
    const dir = path.join(skills.SKILLS_DIR, req.params.slug);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Skill no encontrado' });
    fs.rmSync(dir, { recursive: true });
    res.json({ ok: true });
  });

  return router;
};
