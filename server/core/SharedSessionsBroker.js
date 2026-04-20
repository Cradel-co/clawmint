'use strict';

/**
 * SharedSessionsBroker — routing de eventos de sesión a WebSockets suscritos por token.
 *
 * Uso: un WS cliente envía `{ type: 'init', sessionType: 'shared', token }`. El
 * broker valida el token via `sharedSessionsRepo`, registra el ws bajo ese token,
 * y al recibir eventos `chat:message` (emit via eventBus) broadcast a todos los ws
 * suscritos a la sesión correspondiente.
 *
 * NO modifica el ConversationService — confía en que emita eventos vía eventBus
 * con shape `{ sessionId, message, ... }`. Fase 12.4.
 */

class SharedSessionsBroker {
  constructor({ sharedSessionsRepo, eventBus, logger = console } = {}) {
    if (!sharedSessionsRepo) throw new Error('sharedSessionsRepo requerido');
    this._repo = sharedSessionsRepo;
    this._bus = eventBus || null;
    this._logger = logger;
    /** @type {Map<string, Set<WebSocket>>} session_id → set of ws */
    this._subs = new Map();
    this._wireEvents();
  }

  _wireEvents() {
    if (!this._bus || typeof this._bus.on !== 'function') return;
    // Eventos que queremos replicar a clientes compartidos
    const replicate = (eventName) => {
      this._bus.on(eventName, (payload) => {
        const sid = payload && (payload.sessionId || payload.session_id);
        if (!sid) return;
        this.broadcast(sid, { type: eventName, payload });
      });
    };
    replicate('chat:message');
    replicate('chat:tool_use');
    replicate('chat:stream');
    replicate('session:updated');
  }

  /**
   * Llamar desde el WS handler al recibir init con token.
   * Retorna true si aceptó la suscripción.
   */
  subscribe(ws, token) {
    const record = this._repo.getByToken(token);
    if (!record) {
      try { ws.send(JSON.stringify({ type: 'share_error', error: 'token inválido o expirado' })); } catch {}
      return false;
    }
    const sid = record.session_id;
    if (!this._subs.has(sid)) this._subs.set(sid, new Set());
    this._subs.get(sid).add(ws);

    const self = this;
    const cleanup = () => {
      const set = self._subs.get(sid);
      if (set) {
        set.delete(ws);
        if (set.size === 0) self._subs.delete(sid);
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    try {
      ws.send(JSON.stringify({
        type: 'share_ready',
        session_id: sid,
        permissions: record.permissions,
      }));
    } catch {}
    return true;
  }

  broadcast(session_id, msg) {
    const set = this._subs.get(session_id);
    if (!set || set.size === 0) return 0;
    const raw = JSON.stringify(msg);
    let delivered = 0;
    for (const ws of set) {
      try {
        if (ws.readyState === 1 /* OPEN */) {
          ws.send(raw);
          delivered++;
        }
      } catch {
        // silently drop — cleanup via ws.on('close')
      }
    }
    return delivered;
  }

  subscriberCount(session_id) {
    const set = this._subs.get(session_id);
    return set ? set.size : 0;
  }
}

module.exports = SharedSessionsBroker;
