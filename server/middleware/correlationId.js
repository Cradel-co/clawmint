'use strict';

/**
 * correlationId middleware — asigna un correlation_id por request.
 *
 * Si el cliente manda `X-Correlation-Id` en el header, se usa tal cual
 * (sanitizado). Si no, se genera uno nuevo con formato `req-<8chars>`.
 *
 * El id se deja en `req.correlationId` + se propaga en el header de respuesta
 * `X-Correlation-Id` para que el cliente pueda correlacionar.
 *
 * Montar **antes** de todos los routes:
 *   app.use(correlationIdMiddleware);
 *   app.use('/api/sessions', requireAuth, sessionsRouter);
 */

const crypto = require('crypto');

const MAX_ID_LEN = 128;
const SAFE_RE = /^[a-zA-Z0-9_.:\-]+$/;

function _sanitize(id) {
  if (!id || typeof id !== 'string') return null;
  const trimmed = id.slice(0, MAX_ID_LEN);
  if (!SAFE_RE.test(trimmed)) return null;
  return trimmed;
}

function _generate() {
  return `req-${crypto.randomBytes(4).toString('hex')}`;
}

function correlationIdMiddleware(req, res, next) {
  const incoming = _sanitize(req.headers['x-correlation-id'] || req.headers['x-request-id']);
  const id = incoming || _generate();
  req.correlationId = id;
  res.setHeader('X-Correlation-Id', id);
  next();
}

correlationIdMiddleware._internal = { _sanitize, _generate };
module.exports = correlationIdMiddleware;
