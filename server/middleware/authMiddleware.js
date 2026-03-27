'use strict';

const crypto = require('crypto');

// Token interno para requests MCP/localhost que no pasan por login
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || crypto.randomBytes(32).toString('hex');

/**
 * authMiddleware — extrae y verifica JWT del header Authorization.
 *
 * Si el token es válido, setea req.user = { id, role }.
 * Si no hay token o es inválido, req.user = null (no bloquea).
 * Requests internos con X-Internal-Token bypasean auth.
 *
 * Para rutas que requieren auth, usar requireAuth().
 */
function createAuthMiddleware(authService) {
  function authMiddleware(req, _res, next) {
    req.user = null;

    // Bypass: requests internos (MCP tools, etc.)
    if (req.headers['x-internal-token'] === INTERNAL_TOKEN) {
      req.user = { id: '__internal__', internal: true };
      return next();
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return next();

    const token = header.slice(7);
    const payload = authService.verifyAccessToken(token);
    if (payload) {
      req.user = { id: payload.sub };
    }
    next();
  }

  function requireAuth(req, res, next) {
    authMiddleware(req, res, () => {
      if (!req.user) return res.status(401).json({ error: 'Token inválido o expirado' });
      next();
    });
  }

  return { authMiddleware, requireAuth };
}

createAuthMiddleware.INTERNAL_TOKEN = INTERNAL_TOKEN;

module.exports = createAuthMiddleware;
