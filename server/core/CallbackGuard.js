'use strict';

/**
 * CallbackGuard — envuelve callbacks del host con try/catch para que una excepción
 * en un callback no rompa el loop. Los errores se reportan vía event bus.
 *
 * Uso:
 *   const guard = new CallbackGuard({ eventBus, chatId });
 *   const safeOnChunk = guard.wrap('onChunk', onChunk);
 *   safeOnChunk('texto');  // si onChunk throwea, se emite 'loop:callback_error' y se retorna undefined
 *
 * Tanto sync como async. En caso async, retorna una Promise que resuelve a undefined si el cb rechaza.
 */

const CALLBACK_ERROR_EVENT = 'loop:callback_error';

class CallbackGuard {
  /**
   * @param {object} opts
   * @param {object} [opts.eventBus]  event bus para emitir errores (opcional)
   * @param {string} [opts.chatId]    contexto para el payload del evento
   * @param {function(string, Error): void} [opts.onError]  callback extra (log)
   */
  constructor(opts = {}) {
    this._eventBus = opts.eventBus || null;
    this._chatId   = opts.chatId || null;
    this._onError  = typeof opts.onError === 'function' ? opts.onError : null;
  }

  /**
   * Envuelve un callback; si no se provee, retorna noop.
   * @param {string} name       identificador (ej. 'onChunk')
   * @param {function} [cb]     callback original
   * @returns {function}        wrapper que nunca throwea
   */
  wrap(name, cb) {
    if (typeof cb !== 'function') return () => {};
    const self = this;
    return function wrapped(...args) {
      try {
        const ret = cb(...args);
        // Si devuelve promise, agarrar rejection async
        if (ret && typeof ret.then === 'function') {
          return ret.catch((err) => {
            self._report(name, err);
            return undefined;
          });
        }
        return ret;
      } catch (err) {
        self._report(name, err);
        return undefined;
      }
    };
  }

  _report(name, err) {
    const payload = {
      callback: name,
      error: err && err.message ? err.message : String(err),
      chatId: this._chatId,
      timestamp: Date.now(),
    };
    if (this._eventBus && typeof this._eventBus.emit === 'function') {
      try { this._eventBus.emit(CALLBACK_ERROR_EVENT, payload); } catch { /* bus falló — no hay donde reportar */ }
    }
    if (this._onError) {
      try { this._onError(name, err); } catch { /* no-op */ }
    }
  }
}

CallbackGuard.EVENT = CALLBACK_ERROR_EVENT;
module.exports = CallbackGuard;
