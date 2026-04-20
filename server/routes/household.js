'use strict';
const express = require('express');

/**
 * REST /api/household — datos compartidos del hogar.
 *
 * Cualquier user `status='active'` puede leer/escribir.
 *
 * Endpoints:
 *   GET  /:kind                  → list (qs: includeCompleted, upcomingOnly, limit)
 *   POST /:kind                  → create. body: { title, data, dateAt, alertDaysBefore }
 *   PATCH /:kind/:id             → update parcial
 *   DELETE /:kind/:id            → remove
 *   POST /:kind/:id/complete     → marcar completed
 *   POST /:kind/:id/uncomplete   → desmarcar
 *   GET  /summary                → resumen para dashboard
 *   GET  /upcoming               → upcomingAlerts(daysWindow=7)
 */
module.exports = function createHouseholdRouter({ householdRepo, usersRepo, logger }) {
  const router = express.Router();

  if (!householdRepo) {
    router.use((_req, res) => res.status(503).json({ error: 'HouseholdData no disponible' }));
    return router;
  }

  // Middleware: solo users activos pueden tocar datos del hogar.
  router.use((req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'No autenticado' });
    try {
      const u = usersRepo?.getById(req.user.id);
      if (u && u.status && u.status !== 'active') {
        return res.status(403).json({ error: 'Tu cuenta no está activa.' });
      }
    } catch {}
    next();
  });

  router.get('/summary', (_req, res) => {
    try { res.json({ counts: householdRepo.counts(), upcoming: householdRepo.upcomingAlerts(7) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/upcoming', (req, res) => {
    const days = Number(req.query.days) || 7;
    try { res.json(householdRepo.upcomingAlerts(days)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.get('/:kind', (req, res) => {
    try {
      const items = householdRepo.list(req.params.kind, {
        includeCompleted: req.query.includeCompleted === 'true',
        upcomingOnly:     req.query.upcomingOnly === 'true',
        limit:            req.query.limit ? Number(req.query.limit) : null,
      });
      res.json(items);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/:kind', (req, res) => {
    try {
      const { title, data, dateAt, alertDaysBefore } = req.body || {};
      if (!title) return res.status(400).json({ error: 'title requerido' });
      const created = householdRepo.create({
        kind: req.params.kind, title, data, dateAt, alertDaysBefore,
        createdBy: req.user.id,
      });
      res.status(201).json(created);
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.patch('/:kind/:id', (req, res) => {
    try {
      const ok = householdRepo.update(req.params.id, req.body || {}, req.user.id);
      if (!ok) return res.status(404).json({ error: 'no encontrado o sin cambios' });
      res.json(householdRepo.get(req.params.id));
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  router.delete('/:kind/:id', (req, res) => {
    res.json({ ok: householdRepo.remove(req.params.id) });
  });

  router.post('/:kind/:id/complete', (req, res) => {
    res.json({ ok: householdRepo.complete(req.params.id, req.user.id) });
  });

  router.post('/:kind/:id/uncomplete', (req, res) => {
    res.json({ ok: householdRepo.uncomplete(req.params.id, req.user.id) });
  });

  return router;
};
