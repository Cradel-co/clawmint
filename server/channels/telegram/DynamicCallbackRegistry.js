'use strict';

/**
 * DynamicCallbackRegistry — registro en memoria de callbacks dinámicos con TTL.
 *
 * Tipos de acción soportados:
 *   - { type: 'message', text, parse_mode? }       → enviar texto al chat
 *   - { type: 'command', cmd }                      → ejecutar bash, enviar output
 *   - { type: 'prompt', text }                      → enviar como prompt al AI
 *   - { type: 'url', url }                          → (no-op, Telegram abre directo)
 *
 * Cada entrada puede tener:
 *   - once: true   → se elimina tras ejecutarse una vez
 *   - ttl:  ms     → tiempo de vida (default 5 min)
 */

const DEFAULT_TTL = 5 * 60 * 1000; // 5 minutos
const CLEANUP_INTERVAL = 60 * 1000; // 1 minuto

class DynamicCallbackRegistry {
  constructor() {
    /** @type {Map<string, { action: object, expiresAt: number|null, once: boolean }>} */
    this._entries = new Map();

    this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * Registra uno o más callbacks.
   * @param {Object<string, object>} callbacks — { callbackData: { type, ...params, ttl?, once? } }
   */
  registerMany(callbacks) {
    if (!callbacks || typeof callbacks !== 'object') return;
    for (const [key, action] of Object.entries(callbacks)) {
      this.register(key, action);
    }
  }

  /**
   * Registra un callback individual.
   * @param {string} callbackData
   * @param {object} action — { type, ...params, ttl?, once? }
   */
  register(callbackData, action) {
    const ttl = action.ttl != null ? action.ttl : DEFAULT_TTL;
    const once = action.once != null ? action.once : false;

    // Clonar sin ttl/once para guardar solo la acción
    const { ttl: _t, once: _o, ...cleanAction } = action;

    this._entries.set(callbackData, {
      action: cleanAction,
      expiresAt: ttl > 0 ? Date.now() + ttl : null,
      once,
    });
  }

  /**
   * Obtiene la acción para un callback_data. Retorna null si no existe o expiró.
   * Si once=true, elimina la entrada tras obtenerla.
   * @param {string} callbackData
   * @returns {object|null}
   */
  get(callbackData) {
    const entry = this._entries.get(callbackData);
    if (!entry) return null;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._entries.delete(callbackData);
      return null;
    }

    if (entry.once) {
      this._entries.delete(callbackData);
    }

    return entry.action;
  }

  /**
   * Verifica si un callback_data está registrado (sin consumirlo).
   */
  has(callbackData) {
    const entry = this._entries.get(callbackData);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._entries.delete(callbackData);
      return false;
    }
    return true;
  }

  /** Elimina un callback específico */
  remove(callbackData) {
    this._entries.delete(callbackData);
  }

  /** Elimina todos los callbacks que empiezan con un prefijo */
  removeByPrefix(prefix) {
    for (const key of this._entries.keys()) {
      if (key.startsWith(prefix)) this._entries.delete(key);
    }
  }

  /** Limpieza de entradas expiradas */
  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._entries) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this._entries.delete(key);
      }
    }
  }

  /** Stats para debugging */
  stats() {
    return {
      total: this._entries.size,
      entries: [...this._entries.entries()].map(([key, e]) => ({
        key,
        type: e.action.type,
        once: e.once,
        expiresIn: e.expiresAt ? Math.max(0, e.expiresAt - Date.now()) : null,
      })),
    };
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    this._entries.clear();
  }
}

// Singleton
module.exports = new DynamicCallbackRegistry();
