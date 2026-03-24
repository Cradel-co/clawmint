'use strict';
const express = require('express');

module.exports = function createVoiceProvidersRouter() {
  const router = express.Router();

  // GET /voice-providers — lista con configured status
  router.get('/', (_req, res) => {
    try {
      const voiceProviders = require('../voice-providers');
      const ttsConfig      = require('../tts-config');
      const cfg = ttsConfig.getConfig();
      const list = voiceProviders.list().map(p => ({
        ...p,
        configured: p.type === 'local' ? true : !!ttsConfig.getApiKey(p.name),
        currentVoice: cfg.providers?.[p.name]?.voice || p.defaultVoice,
        currentModel: cfg.providers?.[p.name]?.model || p.defaultModel,
      }));
      res.json({ providers: list, default: cfg.default, enabled: cfg.enabled });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /voice-providers/default — { provider }
  router.put('/default', (req, res) => {
    try {
      const ttsConfig = require('../tts-config');
      const { provider } = req.body || {};
      if (!provider) return res.status(400).json({ error: 'provider requerido' });
      ttsConfig.setDefault(provider);
      res.json({ ok: true, default: provider });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /voice-providers/:name — { apiKey?, voice?, model? }
  router.put('/:name', (req, res) => {
    try {
      const ttsConfig = require('../tts-config');
      const { apiKey, voice, model } = req.body || {};
      ttsConfig.setProvider(req.params.name, { apiKey, voice, model });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
