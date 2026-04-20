'use strict';

/**
 * ContextCompactor — interface abstracta para estrategias de compactación.
 *
 * Implementaciones actuales:
 *   - SlidingWindowCompactor — legacy, resume los primeros N mensajes
 *   - MicroCompactor         — reemplaza tool results viejos por placeholders
 *   - ReactiveCompactor      — monitorea tokens reales con agresividad escalonada
 *
 * Un `CompactorPipeline` orquesta las tres en cascada.
 *
 * Contract:
 *   shouldCompact(state)  → bool — si true, pipeline llama compact()
 *   compact(history, ctx) → Promise<history> — retorna history (potencialmente) compactada
 *
 * Reglas:
 *   - NUNCA throwear en shouldCompact (debe ser cheap y safe).
 *   - compact() puede throwear — el CompactorPipeline lo captura y sigue al siguiente.
 *   - compact() debe ser idempotente si shouldCompact sigue retornando false tras la aplicación.
 *   - NO mutar el array history — devolver uno nuevo.
 *
 * @abstract
 */

class ContextCompactor {
  /**
   * Decide si esta estrategia aplica al estado actual.
   * @param {object} state
   * @param {number} [state.turnCount]     — cuántos turns llevamos
   * @param {number} [state.historySize]   — messages.length
   * @param {number} [state.usage]         — tokens estimados del próximo request
   * @param {number} [state.contextWindow] — max tokens del modelo
   * @param {object} [state.ctx]           — chatId, agentKey, etc.
   * @returns {boolean}
   */
  shouldCompact(_state) {
    throw new Error(`${this.constructor.name}.shouldCompact() no implementado`);
  }

  /**
   * Compacta el historial. Debe retornar un nuevo array (sin mutar).
   * @param {Array} history       — mensajes en formato provider-agnostic
   * @param {object} [ctx]        — { hookRegistry?, metricsService?, chatId, ... }
   * @returns {Promise<Array>}
   */
  async compact(_history, _ctx) {
    throw new Error(`${this.constructor.name}.compact() no implementado`);
  }

  /** Nombre legible para métricas/logs. Default: className. */
  get name() { return this.constructor.name; }
}

module.exports = ContextCompactor;
