'use strict';

/**
 * capabilities.js — registro de capacidades por provider.
 *
 * Cada feature (streaming, cache, thinking, images, cancellation) declara explícitamente
 * qué soporta cada provider. El LoopRunner consulta esto antes de armar un request,
 * evitando silencios (ej: imágenes ignoradas) o combos no soportados (ej: Ollama vision + tools).
 *
 * Valores para images/tools:
 *  - true  → soporta nativo
 *  - false → no soporta
 *  - 'vision_only' → soporta images pero no simultáneamente con tools
 *  - 'no_vision_models' → soporta tools pero no con modelos de visión
 */

/** @typedef {Object} CachingSpec
 *  @property {'explicit'|'automatic'|'none'} mode
 *  @property {string[]} [ttls]            — solo mode='explicit' (ej. ['5m','1h'])
 *  @property {string[]} [placements]      — solo mode='explicit' (ej. ['system','tools','history'])
 *  @property {number}   [minPrefixTokens] — solo mode='automatic' (requisito del server)
 *  @property {string}   [hit_field]       — dotted path en usage de la response para leer cached tokens
 */

/** @typedef {Object} Capabilities
 *  @property {boolean} streaming
 *  @property {boolean|'implicit'} cache
 *  @property {CachingSpec} [caching]       — Fase 7.5.2: detalles por provider para TTL dual y hit rate
 *  @property {boolean|'adaptive'|'enabled'} thinking
 *  @property {boolean|'vision_only'|'no_vision_models'} images
 *  @property {boolean|'no_vision_models'} tools
 *  @property {boolean|'parallel'} parallelToolCalls
 *  @property {boolean|'partial'} cancellation
 *  @property {number} maxOutputTokens
 */

/** Capabilities por default (provider desconocido o legacy no migrado) */
const DEFAULT_CAPS = Object.freeze({
  streaming: false,
  cache: false,
  thinking: false,
  images: false,
  tools: true,
  parallelToolCalls: false,
  cancellation: false,
  maxOutputTokens: 4096,
});

/** Capabilities declaradas por provider (se amplían a medida que migran a v2) */
const CAPS = Object.freeze({
  anthropic: Object.freeze({
    streaming: true,
    cache: true,
    caching: Object.freeze({
      mode: 'explicit',
      ttls: Object.freeze(['5m', '1h']),
      placements: Object.freeze(['system', 'tools', 'history']),
      hit_field: 'cache_read_input_tokens',
    }),
    thinking: 'adaptive',
    images: true,
    tools: true,
    parallelToolCalls: true,
    cancellation: true,
    maxOutputTokens: 16000,    // dinámico por modelo: 16000 Opus / 8192 Sonnet / 4096 Haiku (ver resolveMaxTokens)
  }),
  openai: Object.freeze({
    streaming: true,
    cache: 'implicit',         // OpenAI cachea server-side, no se configura desde cliente
    caching: Object.freeze({
      mode: 'automatic',
      minPrefixTokens: 1024,
      hit_field: 'prompt_tokens_details.cached_tokens',
    }),
    thinking: false,           // (o1/o3 tienen reasoning implícito, no controlable)
    images: true,
    tools: true,
    parallelToolCalls: true,
    cancellation: true,
    maxOutputTokens: 8192,
  }),
  gemini: Object.freeze({
    streaming: true,
    cache: false,
    caching: Object.freeze({
      mode: 'explicit',
      ttls: Object.freeze(['1h', '24h']),
      placements: Object.freeze(['system', 'tools']),
    }),
    thinking: false,
    images: true,
    tools: true,
    parallelToolCalls: false,
    cancellation: true,
    maxOutputTokens: 8192,
  }),
  deepseek: Object.freeze({
    streaming: true,
    cache: 'implicit',
    caching: Object.freeze({
      mode: 'automatic',
      hit_field: 'prompt_cache_hit_tokens',
    }),
    thinking: false,
    images: false,
    tools: true,
    parallelToolCalls: true,
    cancellation: true,
    maxOutputTokens: 8192,
  }),
  grok: Object.freeze({
    streaming: true,
    cache: false,
    caching: Object.freeze({
      mode: 'automatic',        // xAI hace cache implícito server-side en prefixes largos
      hit_field: 'cached_tokens',
    }),
    thinking: false,
    images: true,
    tools: true,
    parallelToolCalls: true,
    cancellation: true,
    maxOutputTokens: 8192,
  }),
  ollama: Object.freeze({
    streaming: true,           // ambas ramas (vision nativa y OpenAI-compat) soportan streaming
    cache: false,
    caching: Object.freeze({ mode: 'none' }),   // local — no aplica
    thinking: false,
    images: 'vision_only',     // soporta vision PERO sin tools simultáneamente
    tools: 'no_vision_models', // soporta tools PERO no con modelos vision
    parallelToolCalls: false,
    cancellation: true,
    maxOutputTokens: 4096,
  }),
  'claude-code': Object.freeze({
    // Wrapper CLI — no entra al LoopRunner, tiene su propia ruta en ConversationService
    streaming: true,           // via onChunk callback
    cache: true,               // lo gestiona el CLI
    thinking: true,            // lo gestiona el CLI
    images: true,              // via OCR / adjunto
    tools: true,               // internas al CLI
    parallelToolCalls: true,
    cancellation: true,        // vía señal al proceso
    maxOutputTokens: 0,        // N/A — gestionado por CLI
  }),
  'gemini-cli': Object.freeze({
    streaming: true,
    cache: false,
    thinking: false,
    images: false,
    tools: true,
    parallelToolCalls: false,
    cancellation: true,
    maxOutputTokens: 0,
  }),
});

/**
 * @param {string} providerName
 * @returns {Capabilities} — retorna DEFAULT_CAPS si el provider es desconocido
 */
function get(providerName) {
  return CAPS[providerName] || DEFAULT_CAPS;
}

/**
 * @param {string} providerName
 * @param {keyof Capabilities} feature
 * @returns {boolean} — true si la feature está habilitada (trata 'implicit'/'adaptive'/'vision_only' como truthy)
 */
function supports(providerName, feature) {
  const caps = get(providerName);
  const v = caps[feature];
  return v === true || (typeof v === 'string' && v !== 'false');
}

/**
 * Devuelve un array de nombres de providers conocidos (útil para listar capabilities en UI admin).
 */
function list() {
  return Object.keys(CAPS);
}

module.exports = { CAPS, DEFAULT_CAPS, get, supports, list };
