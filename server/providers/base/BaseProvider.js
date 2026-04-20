'use strict';

/**
 * BaseProvider — clase abstracta para providers v2.
 *
 * Los providers v2 son async generators que yieldan eventos de `ProviderEvents`.
 * Este archivo define el contrato pero NO es de uso obligatorio (los providers siguen
 * pudiendo ser módulos `{ name, chat }` como siempre). Queda como referencia y base para
 * los providers nuevos que se escriban desde cero.
 *
 * Uso:
 *   class MyProvider extends BaseProvider { ... }
 *   const instance = new MyProvider();
 *   for await (const ev of instance.chat(args)) { ... }
 */

const { DEFAULT_CAPS } = require('../capabilities');

class BaseProvider {
  /** @type {string} identificador corto, ej: 'anthropic' */
  static name = '';
  /** @type {string} label legible */
  static label = '';
  /** @type {string} modelo default si el caller no especifica */
  static defaultModel = '';
  /** @type {string[]} modelos soportados */
  static models = [];

  /**
   * Retorna las capabilities de este provider.
   * Por default devuelve DEFAULT_CAPS; las subclases deben sobrescribir.
   * @returns {import('../capabilities').Capabilities}
   */
  static getCapabilities() {
    return DEFAULT_CAPS;
  }

  /**
   * Contrato de `chat` v2.
   * @param {Object} opts
   * @param {string|Array} opts.systemPrompt
   * @param {Array} opts.history
   * @param {Array} [opts.images]
   * @param {Array} [opts.tools]
   * @param {string|Object} [opts.toolChoice]
   * @param {string} opts.apiKey
   * @param {string} [opts.model]
   * @param {number} [opts.maxTokens]
   * @param {boolean} [opts.enableStreaming=true]
   * @param {boolean} [opts.enableCache=false]
   * @param {'adaptive'|'enabled'|false} [opts.enableThinking=false]
   * @param {number} [opts.thinkingBudget]
   * @param {number} [opts.temperature]
   * @param {AbortSignal} [opts.signal]
   * @param {Function} [opts.executeTool]
   * @param {string} [opts.channel]
   * @param {string} [opts.agentRole]
   * @yields {import('./ProviderEvents').ProviderEvent}
   */
  async *chat(opts) {
    void opts;
    throw new Error(`${this.constructor.name}.chat() no implementado`);
  }
}

module.exports = BaseProvider;
