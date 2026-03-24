'use strict';
const express = require('express');

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;?]*[A-Za-z@]/g, '')          // CSI (incluye ?2004h, ?2004l, etc.)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC (título de ventana, etc.)
    .replace(/\x1B[A-Z\\]/g, '')                        // Escape sequences simples
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '')          // otros control chars
    .replace(/\r/g, '')
    .trim();
}

module.exports = function createSessionsRouter({ sessionManager }) {
  const router = express.Router();

  // GET /sessions — listar sesiones activas
  router.get('/', (_req, res) => {
    res.json(sessionManager.list().map(s => s.toJSON()));
  });

  // POST /sessions — crear sesión
  // Body: { type?, command?, cols?, rows? }
  router.post('/', (req, res) => {
    const { type = 'pty', command, cols = 80, rows = 24 } = req.body || {};
    const session = sessionManager.create({ type, command, cols, rows });
    res.status(201).json(session.toJSON());
  });

  // GET /sessions/:id — info de sesión
  router.get('/:id', (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session.toJSON());
  });

  // DELETE /sessions/:id — cerrar sesión
  router.delete('/:id', (req, res) => {
    const ok = sessionManager.destroy(req.params.id);
    res.json({ ok });
  });

  // POST /sessions/:id/input — input raw (retorna inmediato)
  // Body: { text }
  router.post('/:id/input', (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const { text } = req.body || {};
    if (typeof text !== 'string') return res.status(400).json({ error: 'text requerido' });
    session.input(text);
    res.json({ ok: true });
  });

  // POST /sessions/:id/message — envía mensaje y espera respuesta completa
  // Body: { text }
  // Response: { response, raw }
  router.post('/:id/message', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const { text } = req.body || {};
    if (typeof text !== 'string') return res.status(400).json({ error: 'text requerido' });

    try {
      const result = await session.sendMessage(text);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /sessions/:id/stream — SSE: output en tiempo real
  router.get('/:id/stream', (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const unsub = session.onOutput((data, event) => {
      if (event === 'exit') {
        res.write('event: exit\ndata: {}\n\n');
        res.end();
      } else {
        res.write(`data: ${JSON.stringify({ data })}\n\n`);
      }
    });

    req.on('close', unsub);
  });

  // GET /sessions/:id/output?since=0 — output buffereado desde timestamp
  router.get('/:id/output', (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const since = parseInt(req.query.since) || 0;
    const raw = session.getOutputSince(since);
    res.json({ raw, response: stripAnsi(raw), ts: Date.now() });
  });

  return router;
};
