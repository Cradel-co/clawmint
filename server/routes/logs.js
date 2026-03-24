'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

const LOG_FILE        = path.join(__dirname, '..', 'server.log');
const LOG_CONFIG_FILE = path.join(__dirname, '..', 'logs.json');

function _loadLogConfig() {
  try {
    if (fs.existsSync(LOG_CONFIG_FILE))
      return JSON.parse(fs.readFileSync(LOG_CONFIG_FILE, 'utf8'));
  } catch {}
  return { enabled: true };
}

function _saveLogConfig(cfg) {
  try { fs.writeFileSync(LOG_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch {}
}

module.exports = function createLogsRouter({ logger }) {
  const router = express.Router();

  // GET /logs/config — ver estado actual
  router.get('/config', (_req, res) => {
    res.json(_loadLogConfig());
  });

  // POST /logs/config — cambiar config  { enabled: true|false }
  router.post('/config', (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) requerido' });
    const cfg = { enabled };
    _saveLogConfig(cfg);
    logger.info(`Logs ${enabled ? 'activados' : 'desactivados'}.`);
    res.json(cfg);
  });

  // GET /logs/tail?lines=100 — últimas N líneas del log
  router.get('/tail', (req, res) => {
    const n = Math.min(parseInt(req.query.lines) || 100, 2000);
    try {
      const content = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
      const lines = content.split('\n').filter(Boolean);
      res.json({ lines: lines.slice(-n) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /logs — limpiar log
  router.delete('/', (_req, res) => {
    try {
      fs.writeFileSync(LOG_FILE, '', 'utf8');
      logger.info('Log limpiado.');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
