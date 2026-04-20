'use strict';

/**
 * routes/metrics.js — exporta métricas del MetricsService.
 *
 * - GET /api/metrics        → Prometheus text format (content-type: text/plain)
 * - GET /api/metrics/json   → snapshot JSON (útil para dashboards custom)
 *
 * Ambas rutas requieren `requireAdmin`. Montar en index.js:
 *   app.use('/api/metrics', requireAuth, requireAdmin, metricsRouter);
 */

const express = require('express');

module.exports = function createMetricsRouter({ metricsService }) {
  if (!metricsService) throw new Error('metricsService requerido');
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metricsService.renderPrometheus());
  });

  router.get('/json', (_req, res) => {
    res.json({
      enabled: metricsService.enabled,
      snapshot: metricsService.snapshot(),
    });
  });

  return router;
};
