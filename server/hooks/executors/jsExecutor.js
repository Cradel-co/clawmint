'use strict';

/**
 * jsExecutor — ejecuta handlers JavaScript registrados en memoria.
 *
 * `handlerRef` es una función `async (payload, opts) => { block? | replace? }`
 * o un nombre registrado en un registry in-process (para persistencia lookup).
 *
 * Se usa para tests y para hooks built-in (`audit_log`, `block_dangerous_bash`).
 * NO se usa para hooks definidos por usuarios externos (eso cae en shell/http/skill).
 */

class JsExecutor {
  constructor() {
    /** @type {Map<string, Function>} */
    this._registry = new Map();
  }

  /** Registra una función por nombre para que `handlerRef: 'name'` la resuelva. */
  registerHandler(name, fn) {
    if (typeof fn !== 'function') throw new Error('fn debe ser una función');
    this._registry.set(name, fn);
  }

  unregisterHandler(name) { return this._registry.delete(name); }
  listHandlers() { return Array.from(this._registry.keys()); }

  async execute(hook, payload, opts) {
    const ref = hook.handlerRef;
    let fn;
    if (typeof ref === 'function') fn = ref;
    else if (typeof ref === 'string') fn = this._registry.get(ref);

    if (!fn) throw new Error(`handlerRef no resuelto: "${ref}"`);
    return await fn(payload, opts);
  }
}

module.exports = JsExecutor;
