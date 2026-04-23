'use strict';

/**
 * @clawmint/sdk — cliente de referencia para integrar con el server de Clawmint.
 *
 * Este scaffold vive dentro del server (`server/sdk/`). Para publicar a npm,
 * copiar el contenido a un package independiente con su propio package.json.
 *
 * Uso:
 *   const { createClawmintClient } = require('./sdk');
 *   const client = createClawmintClient({ baseUrl, apiKey });
 *   const session = await client.sessions.create({ agentKey: 'claude' });
 *   await client.sessions.sendMessage(session.id, { text: 'hola' });
 *   for await (const event of client.sessions.subscribe(session.id)) { ... }
 *
 * Transport: HTTP para CRUD, WebSocket para streaming.
 *
 * Fase 12.1 — SDK scaffold.
 */

function createClawmintClient({ baseUrl, apiKey, fetchImpl, WebSocketImpl } = {}) {
  if (!baseUrl) throw new Error('baseUrl requerido');
  const _fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!_fetch) throw new Error('fetch no disponible; pasar fetchImpl');
  const _WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);

  const _headers = (extra = {}) => ({
    'Content-Type': 'application/json',
    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
    ...extra,
  });

  async function _request(method, path, body) {
    const res = await _fetch(`${baseUrl}${path}`, {
      method,
      headers: _headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  return {
    /** Sesiones y mensajería. */
    sessions: {
      create: (params) => _request('POST', '/api/sessions', params || {}),
      get:    (id)     => _request('GET',  `/api/sessions/${encodeURIComponent(id)}`),
      list:   ()       => _request('GET',  '/api/sessions'),
      remove: (id)     => _request('DELETE', `/api/sessions/${encodeURIComponent(id)}`),

      /** Enviar mensaje a una sesión (ruta de convenience — ajustable según API real). */
      sendMessage: (id, { text }) => _request('POST', `/api/sessions/${encodeURIComponent(id)}/message`, { text }),

      /**
       * Subscribe a eventos de una sesión via WebSocket.
       * Retorna un async iterable que yields events hasta `close()`.
       */
      subscribe: (id) => {
        if (!_WS) throw new Error('WebSocket no disponible; pasar WebSocketImpl');
        const wsUrl = baseUrl.replace(/^http/, 'ws');
        const ws = new _WS(wsUrl);
        const queue = [];
        const waiters = [];
        let closed = false;

        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ type: 'init', sessionType: 'listener', sessionId: id }));
        });
        ws.addEventListener('message', (ev) => {
          try {
            const parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
            if (waiters.length) waiters.shift().resolve({ value: parsed, done: false });
            else queue.push(parsed);
          } catch { /* ignore */ }
        });
        ws.addEventListener('close', () => {
          closed = true;
          while (waiters.length) waiters.shift().resolve({ value: undefined, done: true });
        });

        return {
          [Symbol.asyncIterator]() { return this; },
          next() {
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push({ resolve }));
          },
          close() { try { ws.close(); } catch {} },
        };
      },

      /** Compartir sesión (Fase 12.4). */
      share: (id, { ttlHours, permissions } = {}) =>
        _request('POST', `/api/sessions/${encodeURIComponent(id)}/share`, { ttlHours, permissions }),
      getShare: (token) => _request('GET', `/api/session-share/${encodeURIComponent(token)}`),
      revokeShare: (token) => _request('DELETE', `/api/session-share/${encodeURIComponent(token)}`),
      listShares: () => _request('GET', '/api/session-share'),
    },

    /** Agentes. */
    agents: {
      list: () => _request('GET', '/api/agents'),
      get:  (key) => _request('GET', `/api/agents/${encodeURIComponent(key)}`),
    },

    /** Memoria. */
    memory: {
      list: (params) => _request('GET', `/api/memory${_qs(params)}`),
      save: (entry)  => _request('POST', '/api/memory', entry),
    },

    /** Preferencias per-user. */
    preferences: {
      list: () => _request('GET', '/api/user-preferences'),
      get:  (key) => _request('GET', `/api/user-preferences/${encodeURIComponent(key)}`),
      set:  (key, value) => _request('PUT', `/api/user-preferences/${encodeURIComponent(key)}`, { value }),
      remove: (key) => _request('DELETE', `/api/user-preferences/${encodeURIComponent(key)}`),
    },

    /** Escape hatch para endpoints no cubiertos por el SDK. */
    raw: { request: _request },
  };
}

function _qs(params) {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

module.exports = { createClawmintClient };
