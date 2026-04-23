'use strict';

/**
 * legacyShim — envuelve un provider v1 (contrato actual) con la firma v2.
 *
 * Provider v1 emite eventos:
 *   { type: 'text', text }
 *   { type: 'tool_call', name, args }
 *   { type: 'tool_result', name, result }
 *   { type: 'usage', promptTokens, completionTokens }
 *   { type: 'done', fullText }
 *
 * El shim los traduce a ProviderEvents v2 para que LoopRunner los consuma
 * uniformemente. También declara getCapabilities() con valores conservadores.
 *
 * Uso:
 *   const shimmed = legacyShim(require('./anthropic'));
 *   for await (const ev of shimmed.chat(args)) { ... }  // recibe eventos v2
 *
 * Nota: en fase 0 este shim NO se activa por default — `providers/index.js::get()` sigue
 * devolviendo el módulo raw. Se activa explícitamente vía `getV2(name)` si el caller
 * quiere contrato v2. En fase 4 (LoopRunner) se activará por default.
 */

const { make, STOP_REASON } = require('./ProviderEvents');
const capabilities = require('../capabilities');

/**
 * @param {object} legacyProvider — módulo con `{ name, label, defaultModel, models, chat }`
 * @returns {object} provider v2-compatible
 */
function legacyShim(legacyProvider) {
  if (!legacyProvider || typeof legacyProvider.chat !== 'function') {
    throw new Error('legacyShim: provider inválido (no tiene .chat)');
  }

  return {
    name: legacyProvider.name,
    label: legacyProvider.label,
    defaultModel: legacyProvider.defaultModel,
    models: legacyProvider.models,

    getCapabilities() {
      // Si hay capabilities declaradas, usarlas; si no, defaults conservadores.
      return capabilities.get(legacyProvider.name);
    },

    async *chat(args) {
      let toolCallCounter = 0;
      const activeIds = new Map(); // name → last id (para correlacionar tool_call con tool_result)

      try {
        for await (const ev of legacyProvider.chat(args)) {
          if (!ev || !ev.type) continue;

          switch (ev.type) {
            case 'text': {
              const text = ev.text || '';
              if (text) yield make.textDelta(text);
              break;
            }
            case 'tool_call': {
              const id = `legacy_${Date.now()}_${++toolCallCounter}`;
              activeIds.set(ev.name, id);
              yield make.toolCallStart(id, ev.name, toolCallCounter - 1);
              // Argumentos ya vienen parseados en v1 — emitimos end directamente
              yield make.toolCallEnd(id, ev.name, ev.args || {});
              break;
            }
            case 'tool_result': {
              const id = activeIds.get(ev.name) || `legacy_${Date.now()}_result`;
              yield make.toolResult(id, ev.name, ev.result, false);
              activeIds.delete(ev.name);
              break;
            }
            case 'usage': {
              yield make.usage(ev.promptTokens || 0, ev.completionTokens || 0);
              break;
            }
            case 'done': {
              yield make.done(ev.fullText || '', STOP_REASON.END_TURN);
              return;
            }
            default:
              // Pasar eventos desconocidos tal cual (por si el provider emite extras)
              yield ev;
          }
        }
      } catch (err) {
        yield make.error('provider_error', err.message || String(err), false);
        yield make.done('', STOP_REASON.ERROR);
      }
    },
  };
}

module.exports = legacyShim;
