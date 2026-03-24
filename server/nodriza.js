'use strict';

const WebSocket = require('ws');
const nodeDataChannel = require('node-datachannel');

const RECONNECT_BASE = 2000;
const RECONNECT_MAX  = 30000;

class NodrizaConnection {
  /**
   * @param {object} opts
   * @param {object} opts.logger
   * @param {object} opts.nodrizaConfig — nodriza-config.js module
   */
  constructor({ logger, nodrizaConfig }) {
    this._logger = logger;
    this._nodrizaConfig = nodrizaConfig;
    this._ws = null;
    this._authenticated = false;
    this._reconnectDelay = RECONNECT_BASE;
    this._reconnectTimer = null;
    this._intentionalClose = false;

    // peerId → { pc: RTCPeerConnection, dc: DataChannel, _p2pTimer }
    this._peers = new Map();

    // peerId → relayAdapter (conexiones en modo relay)
    this._relayAdapters = new Map();

    // Callback cuando se abre un DataChannel con un peer
    this._onPeerChannel = null;
  }

  /**
   * Inicia la conexión a nodriza.
   * @param {object} opts
   * @param {function} opts.onPeerChannel — (dcAdapter, peerId) => void
   */
  start({ onPeerChannel }) {
    this._onPeerChannel = onPeerChannel;
    this._connect();
  }

  stop() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    this._closePeers();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  isConnected() {
    return this._ws?.readyState === WebSocket.OPEN && this._authenticated;
  }

  getConnectedPeers() {
    const peers = new Set([...this._peers.keys(), ...this._relayAdapters.keys()]);
    return [...peers];
  }

  // ── Conexión a nodriza signaling ──────────────────────────────────────────

  _connect() {
    const cfg = this._nodrizaConfig.getConfig();
    this._intentionalClose = false;
    this._authenticated = false;

    this._logger.info(`[nodriza] Conectando a ${cfg.url}`);

    try {
      this._ws = new WebSocket(cfg.url);
    } catch (e) {
      this._logger.error('[nodriza] URL inválida:', e.message);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      this._reconnectDelay = RECONNECT_BASE;
      this._logger.info('[nodriza] WebSocket abierto, autenticando...');
      this._send({
        event: 'auth',
        data: { id: cfg.serverId, apiKey: cfg.apiKey, role: 'server' },
      });
    });

    this._ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._handleMessage(msg);
    });

    this._ws.on('close', () => {
      this._ws = null;
      this._authenticated = false;
      this._logger.info('[nodriza] WebSocket cerrado');

      // Relay depende del WS — cerrar adapters relay si se perdió
      for (const [, adapter] of this._relayAdapters) {
        adapter.close();
      }
      this._relayAdapters.clear();

      // Si hay peers P2P activos, no reconectar (nodriza ya no necesaria)
      if (this._peers.size > 0) {
        this._logger.info('[nodriza] P2P activo, signaling no necesario');
        return;
      }
      if (!this._intentionalClose) this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      this._logger.error('[nodriza] WebSocket error:', err.message);
    });
  }

  _handleMessage(msg) {
    switch (msg.event) {
      case 'auth:ok':
        this._authenticated = true;
        this._logger.info(`[nodriza] Autenticado. Peers conectados: ${msg.data.connectedPeers?.length || 0}`);
        // Iniciar conexión P2P con peers ya conectados (si no se crearon por peer:connected)
        for (const peerId of (msg.data.connectedPeers || [])) {
          if (!this._peers.has(peerId)) {
            this._initiatePeerConnection(peerId);
          }
        }
        break;

      case 'auth:error':
        this._logger.error('[nodriza] Auth error:', msg.data?.message);
        break;

      case 'peer:connected':
        this._logger.info(`[nodriza] Peer conectado: ${msg.data.peerId} (${msg.data.role})`);
        this._initiatePeerConnection(msg.data.peerId);
        break;

      case 'peer:disconnected':
        this._logger.info(`[nodriza] Peer desconectado: ${msg.data.peerId}`);
        this._closePeer(msg.data.peerId);
        break;

      case 'signal:offer':
        this._handleOffer(msg.data.fromId, msg.data.sdp);
        break;

      case 'signal:answer':
        this._handleAnswer(msg.data.fromId, msg.data.sdp);
        break;

      case 'signal:ice-candidate':
        this._handleIceCandidate(msg.data.fromId, msg.data.candidate);
        break;

      case 'relay:activated': {
        const peerId = msg.data.peerId;
        this._logger.info(`[nodriza] Relay activado con ${peerId}`);
        this._createRelayAdapter(peerId);
        break;
      }

      case 'relay:message': {
        const { fromId, payload } = msg.data;
        const adapter = this._relayAdapters.get(fromId);
        if (adapter) {
          // Emitir el mensaje como si viniera del DataChannel
          adapter._emitMessage(JSON.stringify(payload));
        }
        break;
      }

      case 'error':
        this._logger.warn('[nodriza] Error:', msg.data?.message);
        break;
    }
  }

  // ── WebRTC P2P ────────────────────────────────────────────────────────────

  _initiatePeerConnection(peerId) {
    // Si ya existe, cerrar primero
    if (this._peers.has(peerId)) {
      this._closePeer(peerId);
    }

    this._logger.info(`[nodriza] Creando PeerConnection para ${peerId}`);

    const pc = new nodeDataChannel.PeerConnection(`peer-${peerId}`, {
      iceServers: ['stun:stun.l.google.com:19302'],
    });

    const peerState = { pc, dc: null };
    this._peers.set(peerId, peerState);

    pc.onLocalDescription((sdp, type) => {
      const event = type === 'offer' ? 'signal:offer' : 'signal:answer';
      this._send({ event, data: { targetId: peerId, sdp } });
    });

    pc.onLocalCandidate((candidate, mid) => {
      this._send({
        event: 'signal:ice-candidate',
        data: {
          targetId: peerId,
          candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 },
        },
      });
    });

    pc.onStateChange((state) => {
      this._logger.info(`[nodriza] PeerConnection ${peerId} state: ${state}`);
      if (state === 'closed' || state === 'failed') {
        this._closePeer(peerId);
      }
    });

    // terminal-live es el "server", crea el DataChannel
    const dc = pc.createDataChannel('terminal');
    peerState.dc = dc;
    this._setupDataChannel(dc, peerId);

    // Timeout: si el DataChannel no abre en 15s, caer a relay
    const p2pTimeout = setTimeout(() => {
      const peer = this._peers.get(peerId);
      if (!peer?.dc || !peer.dc.isOpen()) {
        this._logger.info(`[nodriza] P2P timeout para ${peerId} — solicitando relay`);
        this._requestRelay(peerId);
      }
    }, 15000);

    // Guardar el timer para limpiarlo si P2P abre a tiempo
    peerState._p2pTimer = p2pTimeout;
  }

  _handleOffer(fromId, sdp) {
    // Normalmente terminal-live crea la offer, pero si recibe una, la responde
    let peerState = this._peers.get(fromId);
    if (!peerState) {
      // Crear PC para responder
      const pc = new nodeDataChannel.PeerConnection(`peer-${fromId}`, {
        iceServers: ['stun:stun.l.google.com:19302'],
      });

      peerState = { pc, dc: null };
      this._peers.set(fromId, peerState);

      pc.onLocalDescription((sdp, type) => {
        const event = type === 'offer' ? 'signal:offer' : 'signal:answer';
        this._send({ event, data: { targetId: fromId, sdp } });
      });

      pc.onLocalCandidate((candidate, mid) => {
        this._send({
          event: 'signal:ice-candidate',
          data: {
            targetId: fromId,
            candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 },
          },
        });
      });

      pc.onStateChange((state) => {
        this._logger.info(`[nodriza] PeerConnection ${fromId} state: ${state}`);
        if (state === 'closed' || state === 'failed') {
          this._closePeer(fromId);
        }
      });

      pc.onDataChannel((dc) => {
        peerState.dc = dc;
        this._setupDataChannel(dc, fromId);
      });
    }

    peerState.pc.setRemoteDescription(sdp, 'offer');
  }

  _handleAnswer(fromId, sdp) {
    const peerState = this._peers.get(fromId);
    if (!peerState) return;
    peerState.pc.setRemoteDescription(sdp, 'answer');
  }

  _handleIceCandidate(fromId, candidate) {
    const peerState = this._peers.get(fromId);
    if (!peerState) return;
    peerState.pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid || '0');
  }

  _setupDataChannel(dc, peerId) {
    dc.onOpen(() => {
      this._logger.info(`[nodriza] DataChannel abierto con ${peerId}`);

      // P2P exitoso — limpiar timeout y notificar a nodriza
      const peerData = this._peers.get(peerId);
      if (peerData?._p2pTimer) {
        clearTimeout(peerData._p2pTimer);
        delete peerData._p2pTimer;
      }
      this._send({ event: 'p2p:established' });

      if (this._onPeerChannel) {
        const adapter = this._createDCAdapter(dc, peerId);
        this._onPeerChannel(adapter, peerId);
      }

      // Server mantiene signaling WS abierto para que nodriza no envíe peer:disconnected
      // Solo el client (deskcritter) cierra su signaling WS después del P2P
    });

    dc.onClosed(() => {
      this._logger.info(`[nodriza] DataChannel cerrado con ${peerId}`);
      this._peers.delete(peerId);

      // P2P perdido → reconectar a nodriza para re-señalización
      if (!this._intentionalClose) {
        this._logger.info(`[nodriza] P2P perdido — reconectando a nodriza para re-señalización`);
        this._scheduleReconnect();
      }
    });

    dc.onError((err) => {
      this._logger.error(`[nodriza] DataChannel error con ${peerId}:`, err);
    });
  }

  /**
   * Adapta un DataChannel a la interfaz que startAISession espera (como WebSocket).
   */
  _createDCAdapter(dc, peerId) {
    const messageHandlers = [];
    const closeHandlers = [];

    dc.onMessage((data) => {
      // node-datachannel entrega string o Buffer
      const str = typeof data === 'string' ? data : data.toString();
      for (const h of messageHandlers) h(str);
    });

    dc.onClosed(() => {
      for (const h of closeHandlers) h();
    });

    const adapter = {
      send(data) {
        try { if (dc.isOpen()) dc.sendMessage(data); } catch {}
      },
      on(event, handler) {
        if (event === 'message') messageHandlers.push(handler);
        if (event === 'close') closeHandlers.push(handler);
      },
      get readyState() { return dc.isOpen() ? 1 : 3; },
      OPEN: 1,
      _peerId: peerId,
    };

    return adapter;
  }

  // ── Relay fallback ──────────────────────────────────────────────────────

  _requestRelay(peerId) {
    // Cerrar el intento P2P fallido
    const peer = this._peers.get(peerId);
    if (peer) {
      if (peer._p2pTimer) clearTimeout(peer._p2pTimer);
      if (peer.dc) try { peer.dc.close(); } catch {}
      if (peer.pc) try { peer.pc.close(); } catch {}
      this._peers.delete(peerId);
    }

    // Pedir relay a nodriza
    this._send({ event: 'p2p:failed' });
  }

  _createRelayAdapter(peerId) {
    const self = this;
    const handlers = { message: [], close: [] };

    const relayAdapter = {
      readyState: 1, // OPEN (compatible con dcAdapter)
      OPEN: 1,
      _peerId: peerId,

      send(data) {
        // Enviar vía nodriza WS como relay
        self._send({
          event: 'relay',
          data: { targetId: peerId, payload: JSON.parse(data) },
        });
      },

      on(event, handler) {
        if (handlers[event]) handlers[event].push(handler);
      },

      close() {
        relayAdapter.readyState = 3; // CLOSED
        for (const h of handlers.close) h();
        self._relayAdapters.delete(peerId);
      },

      // Método interno para inyectar mensajes recibidos
      _emitMessage(data) {
        for (const h of handlers.message) h(data);
      },
    };

    this._relayAdapters.set(peerId, relayAdapter);

    // Invocar el mismo callback que se usa para DataChannel P2P
    if (this._onPeerChannel) {
      this._onPeerChannel(relayAdapter, peerId);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /** Cerrar signaling WS sin disparar reconexión (P2P ya establecido) */
  _closeSignaling() {
    if (this._ws) {
      this._logger.info('[nodriza] Cerrando signaling WS (P2P establecido)');
      const ws = this._ws;
      this._ws = null;
      this._authenticated = false;
      // Quitar listeners para no disparar reconexión
      ws.removeAllListeners('close');
      ws.close();
    }
  }

  _closePeer(peerId) {
    const peerState = this._peers.get(peerId);
    if (peerState) {
      if (peerState._p2pTimer) clearTimeout(peerState._p2pTimer);
      try { if (peerState.dc) peerState.dc.close(); } catch {}
      try { peerState.pc.close(); } catch {}
      this._peers.delete(peerId);
    }

    // Cerrar relay adapter si existe para este peer
    const relayAdapter = this._relayAdapters.get(peerId);
    if (relayAdapter) {
      relayAdapter.close();
    }
  }

  _closePeers() {
    for (const peerId of [...this._peers.keys()]) {
      this._closePeer(peerId);
    }
    // Cerrar también las conexiones relay
    for (const [, adapter] of this._relayAdapters) {
      adapter.close();
    }
    this._relayAdapters.clear();
  }

  // ── Utils ─────────────────────────────────────────────────────────────────

  _send(msg) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._logger.info(`[nodriza] Reconectando en ${this._reconnectDelay}ms...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX);
      this._connect();
    }, this._reconnectDelay);
  }
}

module.exports = NodrizaConnection;
