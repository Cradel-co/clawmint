'use strict';

const capabilities = require('./capabilities');
const legacyShim = require('./base/legacyShim');

const providers = {
  'claude-code': require('./claude-code'),
  'gemini-cli':  require('./gemini-cli'),
  'anthropic':   require('./anthropic'),
  'gemini':      require('./gemini'),
  'openai':      require('./openai'),
  'grok':        require('./grok'),
  'deepseek':    require('./deepseek'),
  'ollama':      require('./ollama'),
};

/**
 * Conjunto de providers que ya implementan el contrato v2 nativamente (streaming,
 * cancellation, cache stats, thinking deltas). Se define vía env `PROVIDER_V2_ENABLED_FOR=a,b,c`
 * para activación gradual por fase, sin cambios de código.
 *
 * Default cuando la env no está definida: todos los providers v2 activos.
 * Para desactivar todos: `PROVIDER_V2_ENABLED_FOR=` (string vacío explícito).
 */
const DEFAULT_V2_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'grok', 'gemini', 'ollama'];
const V2_ENABLED = new Set(
  process.env.PROVIDER_V2_ENABLED_FOR === undefined
    ? DEFAULT_V2_PROVIDERS
    : process.env.PROVIDER_V2_ENABLED_FOR
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
);

/** Rollback rápido por provider específico vía env var dedicada */
if (process.env.ANTHROPIC_USE_V2 === 'false') V2_ENABLED.delete('anthropic');

module.exports = {
  list() {
    return Object.values(providers).map(p => ({
      name:         p.name,
      label:        p.label,
      models:       p.models,
      defaultModel: p.defaultModel,
    }));
  },

  async listAsync() {
    const ollama = providers['ollama'];
    if (ollama && typeof ollama.fetchModels === 'function') {
      await ollama.fetchModels();
    }
    return this.list();
  },

  /**
   * Retorna el módulo del provider tal como está (contrato v1).
   * ConversationService actual consume este contrato.
   */
  get(name) {
    return providers[name] || providers['anthropic'];
  },

  /**
   * Retorna el provider envuelto para exponer contrato v2 (ProviderEvents).
   * Si el provider ya está en V2_ENABLED, se asume que emite eventos v2 nativamente y se devuelve raw.
   * En caso contrario, se envuelve con `legacyShim`.
   *
   * LoopRunner (fase 4) usará este método. En fase 0 existe pero nadie lo llama aún.
   */
  getV2(name) {
    const p = providers[name] || providers['anthropic'];
    if (V2_ENABLED.has(p.name)) return p;
    return legacyShim(p);
  },

  /** @returns {import('./capabilities').Capabilities} */
  getCapabilities(name) {
    return capabilities.get(name);
  },

  /** true si el provider ya tiene contrato v2 nativo */
  isV2(name) {
    return V2_ENABLED.has(name);
  },
};
