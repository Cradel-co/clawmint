/**
 * WsManager — WebSocket con reconexión exponential backoff, message queue y pub/sub.
 *
 * Basado en el patrón probado de TerminalPanel (5 intentos, 1s→16s).
 * Usado por chatStore y listenerWs.
 */

export interface WsManagerOptions {
  url: string;
  /** Genera el payload de init que se envía al conectar/reconectar */
  buildInitPayload: () => Record<string, unknown>;
  /** Máx intentos de reconexión antes de rendirse (default: 5) */
  maxReconnectAttempts?: number;
  /** Callback cuando cambia el estado de conexión */
  onStatusChange?: (connected: boolean) => void;
}

type MessageHandler = (msg: any) => void;

export class WsManager {
  private ws: WebSocket | null = null;
  private url: string;
  private buildInitPayload: () => Record<string, unknown>;
  private maxReconnectAttempts: number;
  private onStatusChange?: (connected: boolean) => void;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private _connected = false;

  /** Mensajes encolados mientras está desconectado */
  private queue: string[] = [];

  /** Pub/sub: type → Set<handler> */
  private listeners = new Map<string, Set<MessageHandler>>();
  /** Handlers globales (reciben todos los mensajes) */
  private globalListeners = new Set<MessageHandler>();

  constructor(options: WsManagerOptions) {
    this.url = options.url;
    this.buildInitPayload = options.buildInitPayload;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.onStatusChange = options.onStatusChange;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    this.manualClose = false;
    this._createWs();
  }

  disconnect(): void {
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

  /** Forzar reconexión (cierra y vuelve a conectar) */
  reconnect(): void {
    this.reconnectAttempts = 0;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._setConnected(false);
    this._createWs();
  }

  /** Enviar mensaje. Si está desconectado, encola para enviar al reconectar. */
  send(data: Record<string, unknown>): void {
    const raw = JSON.stringify(data);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this.queue.push(raw);
    }
  }

  /** Suscribir a un tipo de mensaje específico */
  subscribe(type: string, handler: MessageHandler): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  /** Suscribir a todos los mensajes */
  subscribeAll(handler: MessageHandler): () => void {
    this.globalListeners.add(handler);
    return () => { this.globalListeners.delete(handler); };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _createWs(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this._setConnected(true);

      // Enviar init payload
      const payload = this.buildInitPayload();
      ws.send(JSON.stringify(payload));

      // Vaciar cola de mensajes pendientes
      while (this.queue.length > 0) {
        const msg = this.queue.shift()!;
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Dispatch a listeners por tipo
        const typeListeners = this.listeners.get(msg.type);
        if (typeListeners) {
          for (const handler of typeListeners) handler(msg);
        }

        // Dispatch a listeners globales
        for (const handler of this.globalListeners) handler(msg);
      } catch { /* JSON inválido, silenciar */ }
    };

    ws.onclose = () => {
      this._setConnected(false);
      if (this.manualClose) return;

      if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

      const delay = Math.pow(2, this.reconnectAttempts) * 1000 + Math.random() * 500;
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => this._createWs(), delay);
    };

    ws.onerror = () => {
      // onclose se dispara automáticamente después de onerror
    };
  }

  private _setConnected(v: boolean): void {
    if (this._connected !== v) {
      this._connected = v;
      this.onStatusChange?.(v);
    }
  }
}
