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
      const { email, password, name, firstAdmin, inviteCode } = req.body;
      const result = await authService.register(email, password, name, {
        firstAdmin: !!firstAdmin,
        inviteCode: inviteCode || null,
      });
      // Si quedó pending → 202 (Accepted, no procesado completo) sin tokens.
      if (result.pending) return res.status(202).json(result);
      res.status(201).json(result);
    } catch (err) {
      const status = err.message.includes('ya está registrado') ? 409
                  : /invitaci|inválid/i.test(err.message) ? 400
                  : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // ── Invitation lookup público (sin auth) ──────────────────────────────────
  // Permite al cliente, antes de mostrar el form, validar que el código es OK.
  router.get('/invitations/:code', (req, res) => {
    try {
      const info = authService.inspectInvitation(req.params.code);
      if (!info) return res.status(503).json({ error: 'Invitations no disponibles' });
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Status (público, sin auth) ─────────────────────────────────────────────
  // Usado por el client para detectar first-run y mostrar el wizard.
  router.get('/status', (_req, res) => {
    let firstRun = false;
    try {
      firstRun = typeof usersRepo.count === 'function' ? usersRepo.count() === 0 : false;
    } catch { /* no-op */ }
    let version = null;
    try { version = require('../package.json').version; } catch {}
    res.json({ firstRun, version });
  });

  // ── Admin endpoints (requireAuth + rol admin) ──────────────────────────────
  // GET  /admin/users          — lista todos los users + identidades
  // PATCH /admin/users/:id     — cambiar role ({role: 'admin'|'user'})
  // DELETE /admin/users/:id    — eliminar user (no puede eliminar a sí mismo)

  function requireAdmin(req, res, next) {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const u = usersRepo.getById(req.user.id);
      if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado — solo administradores' });
      req.adminUser = u;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  router.get('/admin/users', requireAuth, requireAdmin, (_req, res) => {
    try {
      const users = typeof usersRepo.listAll === 'function' ? usersRepo.listAll() : [];
      // Scrubbear sensitive fields (password_hash) antes de retornar
      const sanitized = users.map(u => {
        const { password_hash, ...rest } = u;
        return rest;
      });
      res.json(sanitized);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
    try {
      const { role } = req.body || {};
      if (role && !['admin', 'user'].includes(role)) {
        return res.status(400).json({ error: 'role debe ser "admin" o "user"' });
      }
      const target = usersRepo.getById(req.params.id);
      if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

      // Prevenir self-demote (evitar perder el último admin)
      if (target.id === req.adminUser.id && role === 'user') {
        const admins = (typeof usersRepo.listAll === 'function' ? usersRepo.listAll() : [])
          .filter(u => u.role === 'admin');
        if (admins.length <= 1) {
          return res.status(400).json({ error: 'No podés quitarte el role admin siendo el único' });
        }
      }

      const patch = {};
      if (role) patch.role = role;
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
      usersRepo.update(req.params.id, patch);
      const updated = usersRepo.getById(req.params.id);
      const { password_hash, ...rest } = updated || {};
      res.json(rest);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Invitaciones (admin) ─────────────────────────────────────────────────

  router.post('/admin/invitations', requireAuth, requireAdmin, (req, res) => {
    try {
      const { ttlHours, role, familyRole } = req.body || {};
      const ttlMs = ttlHours ? Number(ttlHours) * 3600 * 1000 : 24 * 3600 * 1000;
      const inv = authService.createInvitation(req.adminUser.id, {
        ttlMs,
        role: role || 'user',
        familyRole: familyRole || null,
      });
      if (!inv) return res.status(500).json({ error: 'No pude crear invitación' });
      res.status(201).json(inv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/admin/invitations', requireAuth, requireAdmin, (_req, res) => {
    try {
      res.json(authService.listInvitations());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/admin/invitations/:code', requireAuth, requireAdmin, (req, res) => {
    try {
      const ok = authService.revokeInvitation(req.params.code);
      if (!ok) return res.status(404).json({ error: 'Invitación no encontrada o ya inactiva' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Aprobación de users (admin) ──────────────────────────────────────────

  router.post('/admin/users/:id/approve', requireAuth, requireAdmin, (req, res) => {
    try {
      const ok = authService.approveUser(req.params.id, req.adminUser.id);
      if (!ok) return res.status(404).json({ error: 'Usuario no encontrado' });
      const updated = usersRepo.getById(req.params.id);
      const { password_hash, ...rest } = updated || {};
      res.json(rest);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/admin/users/:id/reject', requireAuth, requireAdmin, (req, res) => {
    try {
      if (req.params.id === req.adminUser.id) {
        return res.status(400).json({ error: 'No podés rechazarte a vos mismo' });
      }
      const ok = authService.rejectUser(req.params.id, req.adminUser.id);
      if (!ok) return res.status(404).json({ error: 'Usuario no encontrado' });
      const updated = usersRepo.getById(req.params.id);
      const { password_hash, ...rest } = updated || {};
      res.json(rest);
    } catch (err) {
      const status = err.message.includes('único admin') ? 400 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  router.post('/admin/users/:id/reactivate', requireAuth, requireAdmin, (req, res) => {
    try {
      const ok = authService.reactivateUser(req.params.id, req.adminUser.id);
      if (!ok) return res.status(404).json({ error: 'Usuario no encontrado' });
      const updated = usersRepo.getById(req.params.id);
      const { password_hash, ...rest } = updated || {};
      res.json(rest);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Conteo rápido de users pending para badge en UI. */
  router.get('/admin/users/pending/count', requireAuth, requireAdmin, (_req, res) => {
    try {
      const count = typeof usersRepo.countByStatus === 'function' ? usersRepo.countByStatus('pending') : 0;
      res.json({ count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
    try {
      if (req.params.id === req.adminUser.id) {
        return res.status(400).json({ error: 'No podés borrarte a vos mismo' });
      }
      const target = usersRepo.getById(req.params.id);
      if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
      const ok = typeof usersRepo.delete === 'function' ? usersRepo.delete(req.params.id) : false;
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Login ───────────────────────────────────────────────────────────────────

  router.post('/login', loginLimiter, async (req, res) => {
    try {
      const { email, password } = req.body;
      const result = await authService.login(email, password);
      res.json(result);
    } catch (err) {
      // Status-related errors → 403 con code para que el cliente diferencie UX.
      if (err.code === 'PENDING_APPROVAL') {
        return res.status(403).json({ error: err.message, code: 'pending' });
      }
      if (err.code === 'ACCOUNT_DISABLED') {
        return res.status(403).json({ error: err.message, code: 'disabled' });
      }
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
