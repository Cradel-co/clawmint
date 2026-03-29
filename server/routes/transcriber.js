'use strict';

const express = require('express');

module.exports = function createTranscriberRouter({ transcriber }) {
  const router = express.Router();

  router.get('/config', (_req, res) => {
    try {
      res.json(transcriber.getConfig());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/config', (req, res) => {
    try {
      const { model, language } = req.body || {};
      if (model) {
        const ok = transcriber.setModel(model);
        if (!ok) return res.status(400).json({ error: `Modelo inválido: ${model}` });
      }
      if (language) {
        const ok = transcriber.setLanguage(language);
        if (!ok) return res.status(400).json({ error: `Idioma inválido: ${language}` });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
