'use strict';
const express = require('express');

/**
 * Router admin-only /api/system-config — key/value global para config sin .env.
 *
 * Diseñado para credenciales OAuth (client_id + client_secret) de providers MCP.
 * Secrets se cifran en disco via TokenCrypto (inyectado en SystemConfigRepository).
 *
 * Endpoints:
 *   GET  /api/system-config/oauth           → estado por provider (sin secretos)
 *   PUT  /api/system-config/oauth/:provider → setear client_id + client_secret
 *   DELETE /api/system-config/oauth/:provider → limpiar credenciales
 *
 *   GET  /api/system-config/keys            → listar todas las keys (metadata, sin values)
 *   GET  /api/system-config/:key            → leer un value (secrets se devuelven con value=null)
 *   PUT  /api/system-config/:key            → setear (body: { value, isSecret })
 *   DELETE /api/system-config/:key
 */
module.exports = function createSystemConfigRouter({ systemConfigRepo, logger }) {
  const router = express.Router();

  if (!systemConfigRepo) {
    router.use((_req, res) => res.status(503).json({ error: 'SystemConfigRepository no disponible' }));
    return router;
  }

  // ── OAuth provider config (endpoint conveniente) ────────────────────────

  const OAUTH_PROVIDERS = ['google', 'github', 'spotify'];

  router.get('/oauth', (_req, res) => {
    const out = {};
    for (const p of OAUTH_PROVIDERS) {
      const id     = systemConfigRepo.get(`oauth:${p}:client_id`);
      const secret = systemConfigRepo.getSecret(`oauth:${p}:client_secret`);
      const envId     = process.env[`${p.toUpperCase()}_CLIENT_ID`];
      const envSecret = process.env[`${p.toUpperCase()}_CLIENT_SECRET`];
      out[p] = {
        provider: p,
        configured: !!(id || envId) && !!(secret || envSecret),
        source: id || secret ? 'db' : (envId || envSecret ? 'env' : null),
        client_id: id ? id : (envId ? '(desde env)' : null),
        has_secret: !!(secret || envSecret),
      };
    }
    res.json(out);
  });

  router.put('/oauth/:provider', (req, res) => {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!OAUTH_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider debe ser uno de: ${OAUTH_PROVIDERS.join(', ')}` });
    }
    const { client_id, client_secret } = req.body || {};
    if (!client_id || !client_secret) {
      return res.status(400).json({ error: 'client_id y client_secret requeridos' });
    }
    try {
      systemConfigRepo.set(`oauth:${provider}:client_id`, String(client_id));
      systemConfigRepo.setSecret(`oauth:${provider}:client_secret`, String(client_secret));
      logger?.info?.(`[system-config] OAuth ${provider} actualizado por admin`);
      res.json({ ok: true, provider, source: 'db' });
    } catch (e) {
      logger?.error?.(`[system-config] error guardando OAuth ${provider}: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/oauth/:provider', (req, res) => {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!OAUTH_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: 'provider inválido' });
    }
    systemConfigRepo.remove(`oauth:${provider}:client_id`);
    systemConfigRepo.remove(`oauth:${provider}:client_secret`);
    res.json({ ok: true, provider, cleared: true });
  });

  // ── CRUD genérico (para otros configs futuros) ──────────────────────────

  router.get('/keys', (_req, res) => {
    res.json(systemConfigRepo.listKeys());
  });

  router.get('/:key', (req, res) => {
    const key = req.params.key;
    const value = systemConfigRepo.get(key);
    if (value === null) return res.status(404).json({ error: 'key no encontrada' });
    res.json({ key, value });
  });

  router.put('/:key', (req, res) => {
    const key = req.params.key;
    const { value, isSecret } = req.body || {};
    if (value === undefined) return res.status(400).json({ error: 'value requerido' });
    try {
      if (isSecret) systemConfigRepo.setSecret(key, String(value));
      else systemConfigRepo.set(key, String(value));
      res.json({ ok: true, key });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/:key', (req, res) => {
    systemConfigRepo.remove(req.params.key);
    res.json({ ok: true, key: req.params.key });
  });

  return router;
};
