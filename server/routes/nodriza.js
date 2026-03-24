'use strict';
const express = require('express');

module.exports = function createNodrizaRouter({ nodrizaInstance, getDataChannelHandler }) {
  const router = express.Router();

  // GET /nodriza/config — config actual (apiKey censurada)
  router.get('/config', (_req, res) => {
    try {
      const nodrizaConfig = require('../nodriza-config');
      const cfg = nodrizaConfig.getConfig();
      if (cfg.apiKey) cfg.apiKey = cfg.apiKey.slice(0, 8) + '…';
      res.json(cfg);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /nodriza/config — actualizar config
  router.put('/config', (req, res) => {
    try {
      const nodrizaConfig = require('../nodriza-config');
      const { url, serverId, apiKey, enabled } = req.body || {};
      const partial = {};
      if (url !== undefined)      partial.url = url;
      if (serverId !== undefined) partial.serverId = serverId;
      if (apiKey !== undefined)   partial.apiKey = apiKey;
      if (enabled !== undefined)  partial.enabled = enabled;
      nodrizaConfig.setConfig(partial);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /nodriza/status — estado de conexión
  router.get('/status', (_req, res) => {
    res.json({
      connected: nodrizaInstance?.isConnected() || false,
      peers: nodrizaInstance?.getConnectedPeers() || [],
    });
  });

  // POST /nodriza/reconnect — forzar reconexión
  router.post('/reconnect', (_req, res) => {
    if (!nodrizaInstance) return res.status(400).json({ error: 'nodriza no inicializada' });
    nodrizaInstance.stop();
    const handler = typeof getDataChannelHandler === 'function' ? getDataChannelHandler() : null;
    nodrizaInstance.start({ onPeerChannel: handler });
    res.json({ ok: true });
  });

  return router;
};
