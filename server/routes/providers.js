'use strict';
const express   = require('express');
const opencodePv = require('../providers/opencode');

module.exports = function createProvidersRouter({ providerConfig, providersModule }) {
  const router = express.Router();

  // GET /providers — lista providers con label, models, si está configurado
  router.get('/', async (_req, res) => {
    const cfg = providerConfig.getConfig();
    const providers = await providersModule.listAsync();
    const list = providers.map(p => {
      const base = {
        ...p,
        configured:    ['claude-code', 'gemini-cli', 'opencode'].includes(p.name) ? true : !!(providerConfig.getApiKey(p.name)),
        currentModel:  cfg.providers?.[p.name]?.model || p.defaultModel,
      };
      if (p.name === 'opencode') {
        base.installed = opencodePv.isInstalled();
        base.apiKeys   = providerConfig.getOpenCodeKeys();
      }
      return base;
    });
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

  // GET /providers/channel-defaults — { web, telegram, openaiCompat }
  router.get('/channel-defaults', (_req, res) => {
    const cfg = providerConfig.getConfig();
    res.json(cfg.channelDefaults || {});
  });

  // PUT /providers/channel-defaults/:channel — { value }
  router.put('/channel-defaults/:channel', (req, res) => {
    const { channel } = req.params;
    const { value } = req.body || {};
    if (!['web', 'telegram', 'openaiCompat'].includes(channel)) {
      return res.status(400).json({ error: 'channel debe ser web, telegram u openaiCompat' });
    }
    providerConfig.setChannelDefault(channel, value || '');
    res.json({ ok: true, channel, value: value || '' });
  });

  // PUT /providers/:name — { apiKey?, model? }
  router.put('/:name', (req, res) => {
    const { apiKey, model } = req.body || {};
    providerConfig.setProvider(req.params.name, { apiKey, model });
    res.json({ ok: true });
  });

  // --- OpenCode endpoints específicos ---

  // GET /providers/opencode/status — { installed }
  router.get('/opencode/status', (_req, res) => {
    res.json({ installed: opencodePv.isInstalled() });
  });

  // POST /providers/opencode/install — instala opencode-ai via npm (SSE)
  router.post('/opencode/install', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (data) => res.write(`data: ${JSON.stringify({ log: data })}\n\n`);

    send('Instalando opencode-ai via npm...\n');
    opencodePv.install(send)
      .then(() => {
        const ok = opencodePv.isInstalled();
        res.write(`data: ${JSON.stringify({ done: true, installed: ok })}\n\n`);
        res.end();
      })
      .catch(err => {
        res.write(`data: ${JSON.stringify({ done: true, installed: false, error: err.message })}\n\n`);
        res.end();
      });
  });

  // GET /providers/opencode/apikeys — { anthropic, openai, google, ... } (censuradas)
  router.get('/opencode/apikeys', (_req, res) => {
    const keys = providerConfig.getOpenCodeKeys();
    const safe = {};
    for (const [k, v] of Object.entries(keys)) {
      safe[k] = v ? v.slice(0, 8) + '…' : '';
    }
    res.json(safe);
  });

  // PUT /providers/opencode/apikeys/:provider — { key }
  router.put('/opencode/apikeys/:provider', (req, res) => {
    const { key } = req.body || {};
    providerConfig.setOpenCodeKey(req.params.provider, key || '');
    res.json({ ok: true });
  });

  // DELETE /providers/opencode/apikeys/:provider
  router.delete('/opencode/apikeys/:provider', (req, res) => {
    providerConfig.setOpenCodeKey(req.params.provider, '');
    res.json({ ok: true });
  });

  return router;
};
