'use strict';

/**
 * requireAdmin — middleware que rechaza requests cuyo usuario no es admin.
 *
 * Debe montarse DESPUÉS de `requireAuth` (necesita req.user).
 * Bypass: requests internos (`req.user.internal === true`) pasan sin verificación.
 *
 * Uso:
 *   const requireAdmin = createRequireAdmin({ usersRepo });
 *   app.use('/api/permissions', requireAuth, requireAdmin, permissionsRouter);
 */
function createRequireAdmin({ usersRepo }) {
  if (!usersRepo || typeof usersRepo.getById !== 'function') {
    throw new Error('requireAdmin: usersRepo con getById() requerido');
  }
  return function requireAdmin(req, res, next) {
    // Bypass para requests internos
    if (req.user && req.user.internal === true) return next();

    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'No autenticado' });
    }
    const user = usersRepo.getById(req.user.id);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado — solo administradores' });
    }
    req.user.role = user.role;
    next();
  };
}

module.exports = createRequireAdmin;
