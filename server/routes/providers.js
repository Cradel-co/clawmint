'use strict';
const express = require('express');

module.exports = function createProvidersRouter({ providerConfig, providersModule }) {
  const router = express.Router();

  // GET /providers — lista providers con label, models, si está configurado
  router.get('/', async (_req, res) => {
    const cfg = providerConfig.getConfig();
    const providers = await providersModule.listAsync();
    const list = providers.map(p => ({
      ...p,
      configured: ['claude-code', 'ollama'].includes(p.name) ? true : !!(providerConfig.getApiKey(p.name)),
      currentModel: cfg.providers?.[p.name]?.model || p.defaultModel,
    }));
    res.json({ providers: list, default: cfg.default });
  });

  // GET /providers/config — config completa (sin mostrar keys completas)
  router.get('/config', (_req, res) => {
    const cfg = providerConfig.getConfig();
    const sanitized = JSON.parse(JSON.stringify(cfg));
    for (const [name, p] of Object.entries(sanitized.providers || {})) {
      if (p.apiKey) p.apiKey = p.apiKey.slice(0, 8) + '…';
    }
    res.json(sanitized);
  });

  // PUT /providers/default — { provider }
  router.put('/default', (req, res) => {
    const { provider } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'provider requerido' });
    providerConfig.setDefault(provider);
    res.json({ ok: true, default: provider });
  });

  // PUT /providers/:name — { apiKey?, model? }
  router.put('/:name', (req, res) => {
    const { apiKey, model } = req.body || {};
    providerConfig.setProvider(req.params.name, { apiKey, model });
    res.json({ ok: true });
  });

  return router;
};
