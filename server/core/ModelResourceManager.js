'use strict';

const os = require('os');

/**
 * ModelResourceManager — mutex para modelos pesados en memoria.
 *
 * Garantiza que solo UN modelo pesado esté cargado a la vez.
 * Antes de cargar un modelo: acquire(name) → si hay otro, espera a que se descargue.
 * Al descargar: release(name) → permite que otro modelo se cargue.
 *
 * Uso:
 *   await modelManager.acquire('embeddings', unloadFn);
 *   // ... usar modelo ...
 *   modelManager.release('embeddings');
 */

class ModelResourceManager {
  constructor() {
    /** @type {string|null} Nombre del modelo actualmente cargado */
    this._current = null;
    /** @type {Function|null} Función para descargar el modelo actual */
    this._unloadFn = null;
    /** @type {boolean} Hay un acquire en curso */
    this._acquiring = false;
    /** @type {Array<{resolve: Function}>} Cola de espera */
    this._waitQueue = [];
  }

  /**
   * Verifica si hay suficiente memoria libre para un modelo.
   * @param {number} requiredBytes — bytes necesarios
   * @returns {boolean}
   */
  checkMemory(requiredBytes) {
    const free = os.freemem();
    const heapUsed = process.memoryUsage().heapUsed;
    const heapLimit = require('v8').getHeapStatistics().heap_size_limit;
    const heapAvailable = heapLimit - heapUsed;
    // Usar el menor entre RAM libre del OS y heap disponible de Node
    const available = Math.min(free, heapAvailable);
    return available >= requiredBytes;
  }

  /**
   * Obtiene info de memoria actual.
   * @returns {{ freeMB: number, heapUsedMB: number, heapAvailableMB: number }}
   */
  memoryInfo() {
    const heapUsed = process.memoryUsage().heapUsed;
    const heapLimit = require('v8').getHeapStatistics().heap_size_limit;
    return {
      freeMB: Math.round(os.freemem() / 1024 / 1024),
      heapUsedMB: Math.round(heapUsed / 1024 / 1024),
      heapAvailableMB: Math.round((heapLimit - heapUsed) / 1024 / 1024),
    };
  }

  /**
   * Adquiere el slot para un modelo. Si otro modelo está cargado, lo descarga primero.
   * @param {string} name — nombre del modelo ('whisper', 'embeddings', etc.)
   * @param {Function} unloadFn — función async para descargar este modelo cuando otro lo necesite
   * @returns {Promise<void>}
   */
  async acquire(name, unloadFn) {
    // Si ya somos el dueño del slot, solo actualizar unloadFn
    if (this._current === name) {
      this._unloadFn = unloadFn || this._unloadFn;
      return;
    }

    // Si hay otro acquire en curso, esperar a que termine
    if (this._acquiring) {
      await new Promise(resolve => this._waitQueue.push({ resolve }));
    }

    this._acquiring = true;
    try {
      // Si hay otro modelo cargado, descargarlo primero
      if (this._current) {
        console.log(`[ModelRM] Descargando ${this._current} para cargar ${name}`);
        if (this._unloadFn) {
          try { await this._unloadFn(); } catch (e) {
            console.error(`[ModelRM] Error descargando ${this._current}:`, e.message);
          }
        }
        this._current = null;
        this._unloadFn = null;
        if (typeof global.gc === 'function') global.gc();
      }

      this._current = name;
      this._unloadFn = unloadFn || null;
      console.log(`[ModelRM] Slot adquirido: ${name}`);
    } finally {
      this._acquiring = false;
      // Despertar al siguiente en la cola
      if (this._waitQueue.length > 0) {
        const { resolve } = this._waitQueue.shift();
        resolve();
      }
    }
  }

  /**
   * Libera el slot del modelo actual.
   * @param {string} name — debe coincidir con el modelo actual
   */
  release(name) {
    if (this._current !== name) return;
    console.log(`[ModelRM] Slot liberado: ${name}`);
    this._current = null;
    this._unloadFn = null;
    // Notificar a la cola de espera
    while (this._waitQueue.length > 0) {
      const { resolve } = this._waitQueue.shift();
      resolve();
    }
  }

  /** @returns {string|null} Nombre del modelo actualmente cargado */
  get current() { return this._current; }
}

// Singleton
module.exports = new ModelResourceManager();
