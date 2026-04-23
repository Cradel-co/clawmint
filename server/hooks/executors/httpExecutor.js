'use strict';

/**
 * httpExecutor — hook handler HTTP POST.
 *
 * Contrato:
 *   - POST al URL en `handlerRef` con body JSON `{event, payload, ctx}`.
 *   - Response 200 con JSON válido → `{block?, replace?}`.
 *   - Otros status o body inválido → error reportado como hook error.
 *
 * Seguridad:
 *   - `ssrfGuard.sanitizeUrl` bloquea hosts privados.
 *   - Headers custom opcionales en `handlerConfig` (para Authorization desde secrets).
 *   - Timeout provisto por HookRegistry via AbortController.
 */

const { sanitizeUrl } = require('../../core/security/ssrfGuard');

class HttpExecutor {
  /**
   * @param {object} [opts]
   * @param {object} [opts.defaultHeaders] — headers por default (ej. Authorization)
   */
  constructor(opts = {}) {
    this._defaultHeaders = opts.defaultHeaders || {};
  }

  async execute(hook, payload, opts = {}) {
    const url = String(hook.handlerRef || '');
    if (!url) throw new Error('handlerRef (URL) requerido');

    const sanitized = sanitizeUrl(url);
    if (!sanitized.ok) throw new Error(`URL inválida: ${sanitized.reason}`);

    const body = JSON.stringify({
      event: hook.event,
      payload: payload || {},
      ctx: (opts && opts.ctx) || {},
    });

    // El timeout externo de HookRegistry dispara el AbortController.
    // Adicionalmente usamos AbortSignal.timeout como safety net.
    const signal = AbortSignal.timeout(hook.timeoutMs || 10_000);

    let res;
    try {
      res = await fetch(sanitized.url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this._defaultHeaders,
        },
        body,
        signal,
      });
    } catch (e) {
      throw new Error(`fetch fail: ${e.message}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    if (!text.trim()) return null;

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error(`response no es JSON válido: ${e.message}`); }

    return _validateResult(parsed);
  }
}

function _validateResult(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return null;
  const out = {};
  if (obj.block) out.block = String(obj.block);
  if (obj.replace && typeof obj.replace === 'object' && 'args' in obj.replace) {
    out.replace = { args: obj.replace.args };
  }
  return out;
}

HttpExecutor._internal = { _validateResult };
module.exports = HttpExecutor;
