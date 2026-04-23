'use strict';

/**
 * CompactorPipeline — orquesta compactors en cascada.
 *
 * Los compactors se prueban en orden (más agresivos primero). El primero cuyo
 * `shouldCompact(state)` retorna true gana — los siguientes no se ejecutan en
 * ese turn.
 *
 * Si el compact() elegido throwea (que no sea `CompactCircuitOpenError`), se
 * registra como error y se intenta el siguiente. CircuitOpenError se propaga
 * para que el caller decida (generalmente abortar el turn).
 *
 * Orden recomendado al construir: [reactive, micro, sliding].
 *   - reactive es más preciso (tokens reales), pero requiere usage/contextWindow.
 *   - micro es determinista, requiere turnCount + lastMicroAt.
 *   - sliding es fallback — usa history.length.
 *
 * Flag `COMPACTION_ENABLED=false` → `maybeCompact()` retorna history sin tocar.
 */

const { CompactCircuitOpenError } = require('./ReactiveCompactor');

class CompactorPipeline {
  /**
   * @param {object} deps
   * @param {ContextCompactor[]} deps.compactors
   * @param {object} [deps.metricsService]
   * @param {object} [deps.eventBus]
   * @param {object} [deps.logger]
   * @param {boolean} [deps.enabled]
   */
  constructor({ compactors = [], metricsService = null, eventBus = null, logger = console, enabled } = {}) {
    this._compactors = Array.isArray(compactors) ? compactors.slice() : [];
    this._metrics    = metricsService;
    this._bus        = eventBus;
    this._logger     = logger;
    this._enabled    = typeof enabled === 'boolean'
      ? enabled
      : process.env.COMPACTION_ENABLED !== 'false';
  }

  get enabled() { return this._enabled; }
  setEnabled(v) { this._enabled = !!v; }
  size() { return this._compactors.length; }

  /**
   * Evalúa los compactors y aplica el primero que dispara.
   * @param {Array} history
   * @param {object} state  — turnCount, historySize, usage, contextWindow, ctx={chatId,...}
   * @returns {Promise<{ history: Array, applied: string|null }>}
   */
  async maybeCompact(history, state = {}) {
    if (!this._enabled || !Array.isArray(history) || !this._compactors.length) {
      return { history, applied: null };
    }
    const ctx = { ...(state.ctx || {}), ...state };
    for (const c of this._compactors) {
      let triggers = false;
      try { triggers = !!c.shouldCompact({ ...state, history, historySize: history.length }); }
      catch (err) {
        this._logger.warn && this._logger.warn(`[CompactorPipeline] ${c.name}.shouldCompact throweó: ${err.message}`);
        continue;
      }
      if (!triggers) continue;

      const before = history.length;
      const started = Date.now();
      try {
        const newHistory = await c.compact(history, ctx);
        const applied = c.name;
        const durationMs = Date.now() - started;
        this._recordMetric('compact_applied', {
          compactor: applied, before, after: newHistory.length, durationMs,
        });
        this._emit('compact:applied', { compactor: applied, before, after: newHistory.length, durationMs });
        return { history: newHistory, applied };
      } catch (err) {
        if (err instanceof CompactCircuitOpenError) {
          // Propagar — el caller decide abortar
          this._emit('compact:circuit_open', { chatId: err.chatId });
          throw err;
        }
        this._recordMetric('compact_failed', { compactor: c.name, error: err.message });
        this._logger.warn && this._logger.warn(`[CompactorPipeline] ${c.name}.compact falló: ${err.message}`);
        // Seguir probando el próximo
      }
    }
    this._recordMetric('compact_skipped', {});
    return { history, applied: null };
  }

  _recordMetric(event, payload) {
    if (this._metrics && typeof this._metrics.inc === 'function' && event.startsWith('compact_')) {
      try { this._metrics.inc(event, { compactor: payload.compactor || 'none' }); } catch {}
    }
  }

  _emit(event, payload) {
    if (this._bus && typeof this._bus.emit === 'function') {
      try { this._bus.emit(event, payload); } catch {}
    }
  }
}

module.exports = CompactorPipeline;
