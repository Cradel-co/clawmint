/**
 * WsManager — WebSocket con reconexión exponential backoff, message queue y pub/sub.
 *
 * Basado en el patrón probado de TerminalPanel (5 intentos, 1s→16s).
 * Usado por chatStore y listenerWs.
 */

export class WsManager {
  ws = null;
  url;
  buildInitPayload;
  maxReconnectAttempts;
  onStatusChange;
  reconnectAttempts = 0;
  reconnectTimer = null;
  manualClose = false;
  _connected = false;
  queue = [];
  listeners = new Map();
  globalListeners = new Set();

  constructor(options) {
    this.url = options.url;
    this.buildInitPayload = options.buildInitPayload;
    // Hasta este número de intentos hay backoff exponencial (1s, 2s, 4s, 8s, 16s).
    // Después se sigue reintentando indefinidamente con `maxDelayMs` entre intentos.
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.maxDelayMs           = options.maxDelayMs ?? 30000; // 30s cap
    this.onStatusChange = options.onStatusChange;
  }

  get connected() {
    return this._connected;
  }

  connect() {
    this.manualClose = false;
    this._createWs();
  }

  disconnect() {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._setConnected(false);
  }

  reconnect() {
    this.reconnectAttempts = 0;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._setConnected(false);
    this._createWs();
  }

  /**
   * Fuerza un intento de reconexión inmediata, reseteando el contador.
   * Útil para invocar desde visibilitychange / online events o un botón manual.
   * No-op si ya está conectado.
   */
  forceReconnect() {
    if (this._connected) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.manualClose = false;
    this._createWs();
  }

  send(data) {
    const raw = JSON.stringify(data);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.queue.push(raw);
    }
  }

  subscribe(type, handler) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => { set.delete(handler); };
  }

  subscribeAll(handler) {
    this.globalListeners.add(handler);
    return () => { this.globalListeners.delete(handler); };
  }

  _createWs() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this._setConnected(true);

      const payload = this.buildInitPayload();
      ws.send(JSON.stringify(payload));

      while (this.queue.length > 0) {
        const msg = this.queue.shift();
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const typeListeners = this.listeners.get(msg.type);
        if (typeListeners) {
          for (const handler of typeListeners) handler(msg);
        }
        for (const handler of this.globalListeners) handler(msg);
      } catch { /* JSON inválido */ }
    };

    ws.onclose = () => {
      this._setConnected(false);
      if (this.manualClose) return;

      // Reconexión infinita con cap de delay:
      //   Intentos 0..maxReconnectAttempts-1 → backoff exponencial (1s, 2s, 4s, 8s, 16s)
      //   Intentos siguientes → cap a maxDelayMs (30s) forever
      // El attempt counter sigue creciendo solo para telemetría; nunca detiene reconexión.
      const expDelay = Math.pow(2, Math.min(this.reconnectAttempts, this.maxReconnectAttempts)) * 1000;
      const delay = Math.min(expDelay, this.maxDelayMs) + Math.random() * 500;
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => this._createWs(), delay);
    };

    ws.onerror = () => {};
  }

  _setConnected(v) {
    if (this._connected !== v) {
      this._connected = v;
      this.onStatusChange?.(v);
    }
  }
}
