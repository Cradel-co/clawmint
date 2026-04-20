'use strict';

/**
 * routes/mcp-auth.js — endpoints para el flujo OAuth callback per-provider.
 *
 * Fase 11 parked → cerrado.
 *
 * Endpoints:
 *   POST /api/mcp-auth/start/:provider   — body: { mcp_name? }
 *     Genera `state` + URL de auth (si el handler expone buildAuthUrl).
 *     Requiere auth (requireAuth).
 *
 *   GET  /api/mcp-auth/callback/:provider?code=X&state=Y
 *     Callback HTTP que el provider externo llama tras la auth. Público (el
 *     provider no manda cookies). La seguridad viene de `state` validado.
 *
 *   GET  /api/mcp-auth/providers
 *     Lista providers con handler registrado.
 */

const express = require('express');

module.exports = function createMcpAuthRouter({ mcpAuthService, logger, requireAuth } = {}) {
  if (!mcpAuthService) throw new Error('mcpAuthService requerido');
  const router = express.Router();
  const log = logger || console;
  const noAuth = (req, _res, next) => { req.user = req.user || null; next(); };
  const authMw = requireAuth || noAuth;

  router.get('/providers', (_req, res) => {
    res.json(mcpAuthService.listCallbackHandlers());
  });

  // Polling del client durante el OAuth flow. Público (el state es el guard).
  router.get('/status/:state', (req, res) => {
    const status = mcpAuthService.getAuthStatus(req.params.state);
    res.json(status);
  });

  router.post('/start/:provider', authMw, (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const handler = mcpAuthService.getCallbackHandler(req.params.provider);
    if (!handler) return res.status(404).json({ error: `No hay handler para provider "${req.params.provider}"` });

    const mcp_name = req.body?.mcp_name || req.params.provider;
    const { state, expires_at } = mcpAuthService.createAuthState({ mcp_name, user_id: req.user.id });

    let auth_url = null;
    if (typeof handler.buildAuthUrl === 'function') {
      try {
        const redirectUri = `${req.protocol}://${req.get('host')}/api/mcp-auth/callback/${encodeURIComponent(req.params.provider)}`;
        auth_url = handler.buildAuthUrl({ userId: req.user.id, state, redirectUri });
      } catch (err) {
        log.warn && log.warn(`[mcp-auth] buildAuthUrl falló: ${err.message}`);
      }
    }

    res.json({ provider: req.params.provider, state, auth_url, expires_at });
  });

  // Callback público: el provider externo redirige acá tras auth.
  router.get('/callback/:provider', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).json({ error: String(error) });
    if (!code || !state) return res.status(400).json({ error: 'code y state requeridos' });

    try {
      const result = await mcpAuthService.handleCallback({
        provider: req.params.provider,
        code: String(code),
        state: String(state),
        req,
      });
      // HTML simple "listo" — el user ya puede cerrar el tab
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!doctype html><html><body style="font-family:system-ui;padding:2em">
        <h2>Autenticación completada</h2>
        <p>Conectado a <b>${escapeHtml(result.mcp_name)}</b>. Podés cerrar esta pestaña.</p>
      </body></html>`);
    } catch (err) {
      log.warn && log.warn(`[mcp-auth] callback ${req.params.provider} falló: ${err.message}`);
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
