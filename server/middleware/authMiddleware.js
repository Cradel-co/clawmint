'use strict';

/**
 * authMiddleware — extrae y verifica JWT del header Authorization.
 *
 * Si el token es válido, setea req.user = { id, role }.
 * Si no hay token o es inválido, req.user = null (no bloquea).
 *
 * Para rutas que requieren auth, usar requireAuth().
 */
function createAuthMiddleware(authService) {
  function authMiddleware(req, _res, next) {
    req.user = null;
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

module.exports = createAuthMiddleware;
