'use strict';

/**
 * modelTiers.js — catálogo de modelos por provider × tier.
 *
 * 4 tiers canónicos:
 *   - `reasoning` — modelo con extended thinking / reasoning reforzado
 *   - `premium`   — el modelo más capaz del provider (usado para `code`, `general` complejos)
 *   - `balanced`  — rendimiento/costo medio (default para conversación)
 *   - `cheap`     — el modelo más barato (consolidator, microcompact, resúmenes)
 *
 * Override por env (órden de prioridad descendente):
 *   1. `<PROVIDER>_<TIER>_MODEL` — ej. `ANTHROPIC_CHEAP_MODEL=claude-haiku-4-5`
 *   2. `MODEL_TIERS_JSON` — JSON completo que reemplaza todo el catálogo
 *   3. valor hardcoded abajo
 *
 * Fallback cascada: si el tier pedido no tiene modelo declarado, cae al inmediatamente
 * superior en la cadena: cheap → balanced → premium → reasoning.
 *
 * Valores de referencia (abril 2026). **Validar contra docs oficiales al activar**
 * — los providers renombran modelos con frecuencia.
 */

const TIERS = ['cheap', 'balanced', 'premium', 'reasoning'];
const FALLBACK_UP = {
  cheap:     ['cheap', 'balanced', 'premium', 'reasoning'],
  balanced:  ['balanced', 'premium', 'reasoning', 'cheap'],
  premium:   ['premium', 'reasoning', 'balanced', 'cheap'],
  reasoning: ['reasoning', 'premium', 'balanced', 'cheap'],
};

const DEFAULT_TIERS = Object.freeze({
  anthropic: Object.freeze({
    reasoning: 'claude-opus-4-7',
    premium:   'claude-opus-4-7',
    balanced:  'claude-sonnet-4-6',
    cheap:     'claude-haiku-4-5',
  }),
  openai: Object.freeze({
    reasoning: 'o4-mini',
    premium:   'gpt-5',
    balanced:  'gpt-4o',
    cheap:     'gpt-4o-mini',
  }),
  gemini: Object.freeze({
    reasoning: 'gemini-2.5-pro',
    premium:   'gemini-2.5-pro',
    balanced:  'gemini-2.5-flash',
    cheap:     'gemini-2.5-flash-lite',
  }),
  grok: Object.freeze({
    reasoning: 'grok-4-heavy',
    premium:   'grok-4',
    balanced:  'grok-3',
    cheap:     'grok-3-mini',
  }),
  deepseek: Object.freeze({
    reasoning: 'deepseek-reasoner',
    premium:   'deepseek-chat',
    balanced:  'deepseek-chat',
    cheap:     'deepseek-chat',
  }),
  ollama: Object.freeze({
    reasoning: 'qwen2.5:72b',
    premium:   'llama3.3:70b',
    balanced:  'qwen2.5:14b',
    cheap:     'llama3.2:3b',
  }),
});

// Cache lazy: se resuelve al primer acceso, respetando env en ese momento.
let _resolved = null;

function _envOverride(provider, tier) {
  const key = `${String(provider).toUpperCase()}_${String(tier).toUpperCase()}_MODEL`;
  return process.env[key] || null;
}

function _jsonOverride() {
  const raw = process.env.MODEL_TIERS_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { /* silencio: env var malformada no rompe el arranque */ return null; }
}

function _build() {
  const jsonOverride = _jsonOverride() || {};
  const out = {};
  for (const provider of Object.keys(DEFAULT_TIERS)) {
    out[provider] = {};
    for (const tier of TIERS) {
      out[provider][tier] =
        _envOverride(provider, tier) ||
        (jsonOverride[provider] && jsonOverride[provider][tier]) ||
        DEFAULT_TIERS[provider][tier] ||
        null;
    }
  }
  // Providers extras en JSON override que no están en DEFAULT_TIERS
  for (const provider of Object.keys(jsonOverride)) {
    if (!out[provider]) {
      out[provider] = {};
      for (const tier of TIERS) {
        out[provider][tier] = _envOverride(provider, tier) || jsonOverride[provider][tier] || null;
      }
    }
  }
  return out;
}

/**
 * Resuelve el modelo a usar para un provider + tier dado, con cascada de fallback.
 * @param {string} provider
 * @param {string} tier — 'reasoning' | 'premium' | 'balanced' | 'cheap'
 * @returns {string | null} modelId o null si el provider no está registrado
 */
function resolveModelForTier(provider, tier) {
  if (!_resolved) _resolved = _build();
  const table = _resolved[provider];
  if (!table) return null;
  const normalized = String(tier || '').toLowerCase();
  const chain = FALLBACK_UP[normalized] || FALLBACK_UP.balanced;
  for (const t of chain) {
    if (table[t]) return table[t];
  }
  return null;
}

/** Retorna el catálogo completo resuelto (útil para admin UI y tests). */
function getCatalog() {
  if (!_resolved) _resolved = _build();
  return _resolved;
}

/** Re-lee env vars (útil en tests). */
function _reset() { _resolved = null; }

module.exports = {
  resolveModelForTier,
  getCatalog,
  TIERS,
  DEFAULT_TIERS,
  _reset,
};
