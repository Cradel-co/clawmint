'use strict';

const express = require('express');
const { getSystemStatsDetailed } = require('../core/systemStats');

/**
 * Router /api/system — datos agregados de salud del servidor para el dashboard del cliente.
 *
 * Dependencies inyectadas:
 *   - serverStart: number (Date.now() del arranque)
 *   - sessionManager: { list() }
 *   - telegram: { listBots() } | null
 *   - webChannel: { listSessions?() } | null
 *   - providersModule: { list() } | null
 *   - nodrizaInstance: { isConnected(), getConnectedPeers() } | null
 *   - allWebClients: Set<ws>
 *   - locationService: LocationService | null
 *   - requireAdmin: middleware para PUT /location
 */
module.exports = function createSystemRouter({
  serverStart,
  sessionManager,
  telegram,
  webChannel,
  providersModule,
  nodrizaInstance,
  allWebClients,
  locationService = null,
  requireAdmin = null,
}) {
  const router = express.Router();
  const adminOnly = requireAdmin || ((_req, _res, next) => next());

  router.get('/stats', (_req, res) => {
    const sys = getSystemStatsDetailed();

    let ptySessions = 0;
    try { ptySessions = sessionManager?.list?.().length || 0; } catch {}

    let telegramBots = { total: 0, running: 0 };
    try {
      const bots = telegram?.listBots?.() || [];
      telegramBots = {
        total: bots.length,
        running: bots.filter(b => b.running).length,
      };
    } catch {}

    let webSessions = 0;
    try {
      if (typeof webChannel?.listSessions === 'function') webSessions = webChannel.listSessions().length;
    } catch {}

    let providers = { total: 0 };
    try {
      const list = providersModule?.list?.() || [];
      providers = { total: list.length, names: list.map(p => p.name) };
    } catch {}

    let nodriza = { enabled: false, connected: false, peers: 0 };
    if (nodrizaInstance) {
      try {
        nodriza = {
          enabled: true,
          connected: nodrizaInstance.isConnected?.() || false,
          peers: (nodrizaInstance.getConnectedPeers?.() || []).length,
        };
      } catch {}
    }

    const wsClients = allWebClients?.size || 0;
    const processUptimeSec = Math.floor((Date.now() - serverStart) / 1000);

    res.json({
      ts: Date.now(),
      system: sys,
      server: {
        uptime: processUptimeSec,
        startedAt: new Date(serverStart).toISOString(),
        pid: process.pid,
        node: process.version,
      },
      ws: { clients: wsClients },
      sessions: { pty: ptySessions, web: webSessions },
      telegram: telegramBots,
      providers,
      nodriza,
    });
  });

  // ── /lan-addresses ── alias rápido a las IPs LAN (compat con cliente firstRun)
  router.get('/lan-addresses', async (_req, res) => {
    try {
      const lan = locationService ? locationService.getLanInterfaces() : [];
      // Formato compat: { addresses: [{address, interface}, ...] }
      res.json({
        addresses: lan.map(i => ({ address: i.address, interface: i.interface, isTailscale: i.isTailscale })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── /location ── snapshot de ubicación (LAN + Tailscale + IP pública + manual)
  router.get('/location', async (req, res) => {
    if (!locationService) return res.status(503).json({ error: 'LocationService no disponible' });
    try {
      const includePublic = req.query.public !== 'false';
      const forcePublic   = req.query.force === '1' || req.query.refresh === '1';
      const data = await locationService.getLocation({ includePublic, forcePublic });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── PUT /location ── admin-only: setear coords manuales (override)
  router.put('/location', adminOnly, (req, res) => {
    if (!locationService) return res.status(503).json({ error: 'LocationService no disponible' });
    try {
      const { latitude, longitude, name } = req.body || {};
      const result = locationService.setManualLocation({ latitude, longitude, name });
      res.json({ ok: true, manual: result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── DELETE /location ── admin-only: borrar override manual
  router.delete('/location', adminOnly, (_req, res) => {
    if (!locationService) return res.status(503).json({ error: 'LocationService no disponible' });
    try {
      locationService.setManualLocation({ latitude: null, longitude: null });
      res.json({ ok: true, manual: null });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
