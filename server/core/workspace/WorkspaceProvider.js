'use strict';

/**
 * WorkspaceProvider — interface abstracta para aislamiento de subagentes.
 *
 * Fase 8.4 (worktrees git) y Fase 12.2 (Docker/SSH adaptors) implementan
 * esta interface. El `SubagentResolver` recibe un provider y llama `acquire`
 * antes de delegar al subagente.
 *
 * Contract:
 *   acquire(ctx) → { id, cwd, release(): Promise<void>, meta?: object }
 *     - `cwd` es el path donde el subagente ejecuta sus tools
 *     - `release()` hace cleanup (remove worktree, stop container, close SSH)
 *     - `id` es opaco (usado por GC y para listados admin)
 *
 * Reglas:
 *   - `acquire` NO puede throwear salvo en fallo crítico; preferir retornar cwd actual (fail-open).
 *   - `release` debe ser idempotente.
 *
 * @abstract
 */

class WorkspaceProvider {
  /**
   * @param {object} ctx  — contexto del subagente (agentKey, chatId, baseBranch, ...)
   * @returns {Promise<{ id: string, cwd: string, release: () => Promise<void>, meta?: object }>}
   */
  async acquire(_ctx) {
    throw new Error(`${this.constructor.name}.acquire() no implementado`);
  }

  /** Tipo legible (para logs y admin listing). */
  get type() { return this.constructor.name; }
}

module.exports = WorkspaceProvider;
