'use strict';

/**
 * ReactiveCompactor — compacta reactivamente según tokens reales.
 *
 * Thresholds (de Claude Code v2.1.88):
 *   - AUTOCOMPACT_BUFFER_TOKENS = 13000  (preservar para respuesta)
 *   - WARNING_THRESHOLD_TOKENS  = 20000
 *   - MANUAL_COMPACT_BUFFER     = 3000
 *
 * Estrategia:
 *   - usage > contextWindow - BUFFER → compactar.
 *   - pct < 0.90 → agresividad 1: delegar a MicroCompactor.
 *   - pct ≥ 0.90 → agresividad 2: resumir mensajes medios con un summarizer (cheap tier).
 *
 * Circuit breaker:
 *   - `maxFailures` (default 3) fallos consecutivos por chatId → next call throws CompactCircuitOpenError.
 *   - Cada éxito resetea el contador para ese chatId.
 *
 * Diseño modular:
 *   - NO conoce el pipeline ni los otros compactors; recibe `microCompactor` y `summarize` inyectados.
 *   - `summarize` se inyecta en vez de hardcodear model (Fase 7.5.4 enchufa `resolveModelForTier`).
 */

const ContextCompactor = require('./ContextCompactor');

const DEFAULTS = Object.freeze({
  autocompactBufferTokens: 13_000,
  manualCompactBuffer:     3_000,
  maxFailures:             3,
  aggressiveThresholdPct:  0.90,
  preservedTailOnAggressive: 2,
});

class CompactCircuitOpenError extends Error {
  constructor(chatId) {
    super(`compact circuit breaker abierto para chat ${chatId}`);
    this.name = 'CompactCircuitOpenError';
    this.chatId = chatId;
  }
}

class ReactiveCompactor extends ContextCompactor {
  /**
   * @param {object} deps
   * @param {ContextCompactor} deps.microCompactor       — para agresividad 1
   * @param {function} deps.summarize                    — async(messages, {source, ...})→string; agresividad 2
   * @param {object}   [deps.eventBus]
   * @param {object}   [deps.logger]
   * @param {number}   [deps.autocompactBufferTokens]
   * @param {number}   [deps.maxFailures]
   * @param {number}   [deps.aggressiveThresholdPct]
   * @param {number}   [deps.preservedTailOnAggressive]
   */
  constructor({
    microCompactor, summarize, eventBus = null, logger = console,
    autocompactBufferTokens, maxFailures, aggressiveThresholdPct, preservedTailOnAggressive,
  } = {}) {
    super();
    if (!microCompactor || typeof microCompactor.compact !== 'function') {
      throw new Error('ReactiveCompactor: microCompactor requerido');
    }
    if (typeof summarize !== 'function') {
      throw new Error('ReactiveCompactor: summarize(messages, ctx)→string requerido');
    }
    this._micro     = microCompactor;
    this._summarize = summarize;
    this._bus       = eventBus;
    this._logger    = logger;
    this._bufferTokens = Number.isFinite(autocompactBufferTokens) ? autocompactBufferTokens : DEFAULTS.autocompactBufferTokens;
    this._maxFailures  = Number.isFinite(maxFailures)             ? maxFailures             : DEFAULTS.maxFailures;
    this._aggressive   = Number.isFinite(aggressiveThresholdPct)  ? aggressiveThresholdPct  : DEFAULTS.aggressiveThresholdPct;
    this._tailKeep     = Number.isFinite(preservedTailOnAggressive) ? preservedTailOnAggressive : DEFAULTS.preservedTailOnAggressive;
    /** @type {Map<string, number>} chatId → consecutive failures */
    this._failures = new Map();
  }

  shouldCompact(state) {
    if (!state) return false;
    const usage = Number(state.usage);
    const window = Number(state.contextWindow);
    if (!Number.isFinite(usage) || !Number.isFinite(window) || window <= 0) return false;
    return usage > (window - this._bufferTokens);
  }

  async compact(history, ctx = {}) {
    const chatId = (ctx && ctx.chatId) || 'unknown';

    // Circuit breaker check
    if ((this._failures.get(chatId) || 0) >= this._maxFailures) {
      this._emit('compact:circuit_open', { chatId });
      throw new CompactCircuitOpenError(chatId);
    }

    try {
      const result = await this._doCompact(history, ctx);
      this._failures.set(chatId, 0); // reset on success
      return result;
    } catch (err) {
      const n = (this._failures.get(chatId) || 0) + 1;
      this._failures.set(chatId, n);
      this._logger.warn && this._logger.warn(`[ReactiveCompactor] chat=${chatId} fallo ${n}/${this._maxFailures}: ${err.message}`);
      throw err;
    }
  }

  async _doCompact(history, ctx) {
    const usage = Number(ctx.usage || 0);
    const window = Number(ctx.contextWindow || 0);
    const pct = window > 0 ? usage / window : 0;

    const hookRegistry = ctx && ctx.hookRegistry;
    if (hookRegistry && hookRegistry.enabled) {
      try { await hookRegistry.emit('pre_compact', { kind: pct >= this._aggressive ? 'reactive_aggressive' : 'reactive_micro', historySize: history.length, usagePct: pct }); } catch {}
    }

    let newHistory;
    if (pct < this._aggressive) {
      // Agresividad 1: delegar a microCompactor
      newHistory = await this._micro.compact(history, ctx);
    } else {
      // Agresividad 2: resumir medio con summarizer (cheap tier)
      newHistory = await this._summarizeMiddle(history, ctx);
    }

    if (hookRegistry && hookRegistry.enabled) {
      try { await hookRegistry.emit('post_compact', { kind: pct >= this._aggressive ? 'reactive_aggressive' : 'reactive_micro', before: history.length, after: newHistory.length, usagePct: pct }); } catch {}
    }

    return newHistory;
  }

  async _summarizeMiddle(history, ctx) {
    if (!Array.isArray(history) || history.length <= this._tailKeep + 1) return history;
    const first = history[0];
    const tail  = history.slice(-this._tailKeep);
    const middle = history.slice(1, -this._tailKeep);
    if (!middle.length) return history;

    const summary = await this._summarize(middle, {
      provider: ctx.provider,
      model:    ctx.model,
      apiKey:   ctx.apiKey,
      source:   'reactive_compact',
    });
    if (!summary || !String(summary).trim()) return history;
    const summaryMsg = {
      role: 'system',
      content: `[Resumen automático de ${middle.length} mensajes previos]\n${summary}`,
    };
    return [first, summaryMsg, ...tail];
  }

  _emit(event, payload) {
    if (this._bus && typeof this._bus.emit === 'function') {
      try { this._bus.emit(event, payload); } catch {}
    }
  }

  // Expuestos para tests/debug
  _getFailures(chatId) { return this._failures.get(chatId) || 0; }
  _resetFailures(chatId) { if (chatId) this._failures.delete(chatId); else this._failures.clear(); }
}

ReactiveCompactor.DEFAULTS = DEFAULTS;
ReactiveCompactor.CompactCircuitOpenError = CompactCircuitOpenError;
module.exports = ReactiveCompactor;
