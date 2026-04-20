'use strict';

/**
 * LoopDetector — detecta loops infinitos donde el modelo llama la misma tool
 * con los mismos args N veces consecutivas.
 *
 * Ring buffer de tamaño limitado; si los últimos `threshold` elementos
 * tienen mismo `name + argsHash`, se considera loop.
 *
 * No conoce de providers, no emite eventos (lo hace el consumer).
 */

const crypto = require('crypto');

class LoopDetector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.bufferSize=5]   cuántas llamadas recientes recordar
   * @param {number} [opts.threshold=3]    cuántas consecutivas idénticas disparan
   */
  constructor(opts = {}) {
    this.bufferSize = Number.isFinite(opts.bufferSize) ? opts.bufferSize : 5;
    this.threshold  = Number.isFinite(opts.threshold)  ? opts.threshold  : 3;
    if (this.threshold < 2) throw new Error('LoopDetector: threshold debe ser >= 2');
    if (this.threshold > this.bufferSize) throw new Error('LoopDetector: threshold > bufferSize');
    this._ring = [];
  }

  /**
   * Agrega una llamada y evalúa si hay loop.
   * @param {string} name
   * @param {object|string} args
   * @returns {{ detected: boolean, argsHash: string, consecutiveCount: number }}
   */
  track(name, args) {
    const argsHash = this._hash(args);
    const entry = { name, argsHash };
    this._ring.push(entry);
    if (this._ring.length > this.bufferSize) this._ring.shift();

    // Contar cuántos de los últimos son iguales a entry
    let count = 0;
    for (let i = this._ring.length - 1; i >= 0; i--) {
      const e = this._ring[i];
      if (e.name === name && e.argsHash === argsHash) count++;
      else break;
    }
    return {
      detected: count >= this.threshold,
      argsHash,
      consecutiveCount: count,
    };
  }

  /** Limpia el buffer (útil al iniciar nueva iteración). */
  reset() {
    this._ring = [];
  }

  _hash(args) {
    try {
      const json = typeof args === 'string' ? args : JSON.stringify(args);
      return crypto.createHash('sha1').update(json || '').digest('hex').slice(0, 16);
    } catch {
      // Args con circular refs u otro edge — hash por toString
      return crypto.createHash('sha1').update(String(args)).digest('hex').slice(0, 16);
    }
  }
}

module.exports = LoopDetector;
