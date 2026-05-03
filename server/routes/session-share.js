'use strict';

/**
 * routes/session-share.js — API para compartir sesiones entre dispositivos (Fase 12.4).
 *
 * Endpoints:
 *   POST   /api/sessions/:id/share    — crear share. Body: { ttlHours?, permissions? }
 *   GET    /api/session-share/:token  — resolver un token; retorna metadata (sin mensajes)
 *   DELETE /api/session-share/:token  — revocar (solo owner)
 *   GET    /api/session-share         — listar shares del usuario autenticado
 *
 * NO expone el contenido de la sesión acá — eso llega via WebSocket con sessionType='shared'
 * y el mismo token.
 */

const express = require('express');

module.exports = function createSessionShareRouter({ sharedSessionsRepo, sessionManager, logger }) {
  if (!sharedSessionsRepo) throw new Error('sharedSessionsRepo requerido');
  const router = express.Router();
  const log = logger || console;

  // Crear share para una sesión (el caller debe ser dueño de la sesión)
  router.post('/sessions/:id/share', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const session_id = req.params.id;

    // Verificar que la sesión exista y sea del usuario (best-effort — sessionManager.get)
    if (sessionManager && typeof sessionManager.get === 'function') {
      const sess = sessionManager.get(session_id);
      if (!sess) return res.status(404).json({ error: 'session no encontrada' });
      // ownership check: si el sessionManager expone meta.userId, comparar
      if (sess.userId && sess.userId !== req.user.id) {
        return res.status(403).json({ error: 'no sos dueño de esta sesión' });
      }
    }

    const ttlHours = Number(req.body?.ttlHours) || Number(process.env.SESSION_SHARE_TOKEN_TTL_HOURS) || 24;
    const permissions = req.body?.permissions;

    try {
      const created = sharedSessionsRepo.create({
        session_id,
        owner_id: req.user.id,
        permissions,
        ttlHours,
      });
      res.status(201).json(created);
    } catch (err) {
      log.error && log.error('[session-share] create falló:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // Resolver un token — cualquier usuario autenticado con token válido puede ver metadata
  router.get('/session-share/:token', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const record = sharedSessionsRepo.getByToken(req.params.token);
    if (!record) return res.status(404).json({ error: 'token inválido o expirado' });

    // Si hay whitelist de allowedUserIds, verificar
    const allowed = record.permissions && Array.isArray(record.permissions.allowedUserIds);
    if (allowed && !record.permissions.allowedUserIds.includes(req.user.id) && record.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'no tenés acceso a este share' });
    }

    res.json({
      session_id: record.session_id,
      permissions: record.permissions,
      owner_id: record.owner_id,
      expires_at: record.expires_at,
    });
  });

  // Revocar
  router.delete('/session-share/:token', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    const record = sharedSessionsRepo.getByToken(req.params.token);
    if (!record) return res.status(404).json({ error: 'token no encontrado' });
    if (record.owner_id !== req.user.id) return res.status(403).json({ error: 'solo el owner puede revocar' });
    sharedSessionsRepo.remove(req.params.token);
    res.json({ ok: true });
  });

  // Listar mis shares
  router.get('/session-share', (req, res) => {
    if (!req.user || !req.user.id) return res.status(401).json({ error: 'No autenticado' });
    res.json(sharedSessionsRepo.listByOwner(req.user.id));
  });

  return router;
};
