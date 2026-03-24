'use strict';

const crypto = require('crypto');

/**
 * CritterRegistry — singleton que gestiona peers conectados por P2P (deskcritter).
 *
 * Cada peer registrado puede recibir acciones remotas (tools) y devolver resultados.
 */

// peerId → { send, pending: Map<actionId, { resolve, reject, timer }> }
const _peers = new Map();

const DEFAULT_TIMEOUT = 30000;

/**
 * Registra un peer conectado.
 * @param {string}   peerId
 * @param {function} sendFn - función que envía un objeto JSON al peer
 */
function register(peerId, sendFn) {
  _peers.set(peerId, { send: sendFn, pending: new Map() });
}

/**
 * Desregistra un peer. Rechaza todas las promesas pendientes.
 * @param {string} peerId
 */
function unregister(peerId) {
  const peer = _peers.get(peerId);
  if (!peer) return;
  for (const [id, entry] of peer.pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(`Critter desconectado (peer ${peerId})`));
  }
  peer.pending.clear();
  _peers.delete(peerId);
}

/**
 * @param {string} peerId
 * @returns {boolean}
 */
function isConnected(peerId) {
  return _peers.has(peerId);
}

/**
 * Extrae peerId de un shellId con formato `p2p-<peerId>`.
 * @param {string} shellId
 * @returns {string|null}
 */
function getPeerIdFromShellId(shellId) {
  if (!shellId || !shellId.startsWith('p2p-')) return null;
  return shellId.slice(4);
}

/**
 * Envía una acción al critter y espera el resultado.
 * @param {string} peerId
 * @param {string} tool     - nombre del tool remoto (bash, file_read, etc.)
 * @param {object} args
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<any>}
 */
function sendAction(peerId, tool, args, timeoutMs = DEFAULT_TIMEOUT) {
  const peer = _peers.get(peerId);
  if (!peer) return Promise.reject(new Error(`Critter no conectado (peer ${peerId})`));

  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.pending.delete(id);
      reject(new Error(`Timeout esperando respuesta del critter (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    peer.pending.set(id, { resolve, reject, timer });

    try {
      peer.send({ type: 'action', id, tool, args });
    } catch (err) {
      clearTimeout(timer);
      peer.pending.delete(id);
      reject(new Error(`Error enviando acción al critter: ${err.message}`));
    }
  });
}

/**
 * Maneja un action_result del critter.
 * @param {string} peerId
 * @param {string} id      - action ID
 * @param {any}    result
 */
function handleResult(peerId, id, result) {
  const peer = _peers.get(peerId);
  if (!peer) return;
  const entry = peer.pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  peer.pending.delete(id);
  entry.resolve(result);
}

/**
 * Maneja un action_error del critter.
 * @param {string} peerId
 * @param {string} id      - action ID
 * @param {string} error
 */
function handleError(peerId, id, error) {
  const peer = _peers.get(peerId);
  if (!peer) return;
  const entry = peer.pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  peer.pending.delete(id);
  entry.reject(new Error(error || 'Error desconocido del critter'));
}

module.exports = { register, unregister, isConnected, getPeerIdFromShellId, sendAction, handleResult, handleError };
