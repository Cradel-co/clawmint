'use strict';

const { Router } = require('express');
const createAuthMiddleware = require('../middleware/authMiddleware');
const rateLimiter = require('../middleware/rateLimiter');

const OAuthService = require('../services/OAuthService');

/**
 * Auth REST API.
 *
 * POST /register             — crear cuenta
 * POST /login                — login con email/contraseña
 * POST /refresh              — renovar tokens
 * POST /logout               — revocar refresh token
 * GET  /me                   — usuario actual
 * POST /link-session         — vincular sesión anónima a cuenta
 * POST /change-password      — cambiar contraseña
 * GET  /oauth/providers      — providers OAuth disponibles
 * GET  /oauth/google         — iniciar flujo Google OAuth
 * GET  /oauth/google/callback — callback Google OAuth
 * GET  /oauth/github         — iniciar flujo GitHub OAuth
 * GET  /oauth/github/callback — callback GitHub OAuth
 */
module.exports = function createAuthRouter({ authService, usersRepo, logger }) {
  const router = Router();
  const { requireAuth } = createAuthMiddleware(authService);

  // Rate limiters
  const loginLimiter    = rateLimiter(5, 60 * 1000);        // 5/min
  const registerLimiter = rateLimiter(3, 60 * 60 * 1000);   // 3/hora

  // ── Register ────────────────────────────────────────────────────────────────

  router.post('/register', registerLimiter, async (req, res) => {
    try {
      const { email, password, name } = req.body;
      const result = await authService.register(email, password, name);
      res.status(201).json(result);
    } catch (err) {
      const status = err.message.includes('ya está registrado') ? 409 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // ── Login ───────────────────────────────────────────────────────────────────

  router.post('/login', loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      const result = await authService.login(email, password);
      res.json(result);
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  // ── Refresh ─────────────────────────────────────────────────────────────────

  router.post('/refresh', (req, res) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) return res.status(400).json({ error: 'refreshToken requerido' });
      const tokens = authService.refreshTokens(refreshToken);
      res.json(tokens);
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  // ── Logout ──────────────────────────────────────────────────────────────────

  router.post('/logout', requireAuth, (req, res) => {
    const { refreshToken, all } = req.body;
    if (all) {
      authService.revokeAllTokens(req.user.id);
    } else if (refreshToken) {
      try { authService.refreshTokens(refreshToken); } catch { /* ya revocado */ }
    }
    res.json({ ok: true });
  });

  // ── Me ──────────────────────────────────────────────────────────────────────

  router.get('/me', requireAuth, (req, res) => {
    const user = authService.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const { password_hash, ...safe } = user;
    const oauthAccounts = authService.getOAuthAccounts(req.user.id);
    res.json({ ...safe, oauthAccounts });
  });

  // ── Link session ────────────────────────────────────────────────────────────

  router.post('/link-session', requireAuth, (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });
    const ok = authService.linkAnonymousSession(req.user.id, sessionId);
    res.json({ ok });
  });

  // ── Change password ─────────────────────────────────────────────────────────

  router.post('/change-password', requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      await authService.changePassword(req.user.id, currentPassword, newPassword);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── OAuth ────────────────────────────────────────────────────────────────────

  const oauthService = new OAuthService({ logger });

  function getBaseUrl(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
  }

  // Providers disponibles
  router.get('/oauth/providers', (_req, res) => {
    res.json({
      google: oauthService.googleConfigured,
      github: oauthService.githubConfigured,
    });
  });

  // ── Google OAuth ──────────────────────────────────────────────────────────

  router.get('/oauth/google', (req, res) => {
    if (!oauthService.googleConfigured) {
      return res.status(501).json({ error: 'Google OAuth no configurado (faltan GOOGLE_CLIENT_ID/SECRET)' });
    }
    const redirectUri = `${getBaseUrl(req)}/api/auth/oauth/google/callback`;
    const url = oauthService.getGoogleAuthUrl(redirectUri);
    res.redirect(url);
  });

  router.get('/oauth/google/callback', async (req, res) => {
    try {
      const { code, state, error } = req.query;
      if (error) {
        return res.send(OAuthService.callbackHtml(null, error));
      }
      const redirectUri = `${getBaseUrl(req)}/api/auth/oauth/google/callback`;
      const profile = await oauthService.handleGoogleCallback(code, state, redirectUri);
      const result = authService.findOrCreateByOAuth('google', profile);
      res.send(OAuthService.callbackHtml(result));
    } catch (err) {
      res.send(OAuthService.callbackHtml(null, err.message));
    }
  });

  // ── GitHub OAuth ──────────────────────────────────────────────────────────

  router.get('/oauth/github', (req, res) => {
    if (!oauthService.githubConfigured) {
      return res.status(501).json({ error: 'GitHub OAuth no configurado (faltan GITHUB_CLIENT_ID/SECRET)' });
    }
    const redirectUri = `${getBaseUrl(req)}/api/auth/oauth/github/callback`;
    const url = oauthService.getGithubAuthUrl(redirectUri);
    res.redirect(url);
  });

  router.get('/oauth/github/callback', async (req, res) => {
    try {
      const { code, state, error } = req.query;
      if (error) {
        return res.send(OAuthService.callbackHtml(null, error));
      }
      const redirectUri = `${getBaseUrl(req)}/api/auth/oauth/github/callback`;
      const profile = await oauthService.handleGithubCallback(code, state, redirectUri);
      const result = authService.findOrCreateByOAuth('github', profile);
      res.send(OAuthService.callbackHtml(result));
    } catch (err) {
      res.send(OAuthService.callbackHtml(null, err.message));
    }
  });

  return router;
};
