'use strict';

/**
 * PlanModeService — estado granular de plan mode por chat.
 *
 * Complementa el `claudeMode='plan'` que ya existe en ConversationService, pero
 * con scope más fino: el modelo puede entrar/salir de plan mode dentro de una
 * conversación sin que el usuario cambie el modo global.
 *
 * Auto-exit: si no se llama `exit()` tras `DEFAULT_AUTO_EXIT_MS` de inactividad
 * (default 5 min), el chat sale automáticamente de plan mode + emite evento
 * `plan_mode:timeout` al eventBus.
 *
 * Los callers (ConversationService al construir execToolFn) consultan `isActive(chatId)`
 * para decidir si wrappear las tools en modo simulado.
 */

const DEFAULT_AUTO_EXIT_MS = 5 * 60 * 1000; // 5 minutos

class PlanModeService {
  /**
   * @param {object} [opts]
   * @param {object} [opts.eventBus]
   * @param {number} [opts.autoExitMs]
   * @param {object} [opts.logger]
   */
  constructor({ eventBus = null, autoExitMs = DEFAULT_AUTO_EXIT_MS, logger = console } = {}) {
    this._bus = eventBus;
    this._autoExitMs = autoExitMs;
    this._logger = logger;
    /** @type {Map<string, { enteredAt: number, reason?: string, timer: NodeJS.Timeout }>} */
    this._active = new Map();
  }

  /**
   * Entra plan mode para un chat. Si ya estaba activo, renueva el timer.
   * @returns {{ enteredAt: number, expiresAt: number }}
   */
  enter(chatId, reason = null) {
    if (!chatId) throw new Error('chatId requerido');
    this._clearTimer(chatId);
    const enteredAt = Date.now();
    const timer = setTimeout(() => this._autoExit(chatId), this._autoExitMs);
    if (timer.unref) timer.unref();
    this._active.set(chatId, { enteredAt, reason, timer });
    this._emit('plan_mode:enter', { chatId, reason, enteredAt });
    return { enteredAt, expiresAt: enteredAt + this._autoExitMs };
  }

  /**
   * Sale de plan mode explícitamente. Retorna true si estaba activo.
   */
  exit(chatId) {
    if (!chatId) return false;
    const entry = this._active.get(chatId);
    if (!entry) return false;
    this._clearTimer(chatId);
    this._active.delete(chatId);
    this._emit('plan_mode:exit', { chatId, durationMs: Date.now() - entry.enteredAt });
    return true;
  }

  isActive(chatId) {
    return !!(chatId && this._active.has(chatId));
  }

  /** Lista chats con plan mode activo (para admin/debug). */
  list() {
    return Array.from(this._active.entries()).map(([chatId, e]) => ({
      chatId, enteredAt: e.enteredAt, reason: e.reason,
    }));
  }

  /** Extiende el timeout de un chat ya activo (usado por `touch`). */
  touch(chatId) {
    const entry = this._active.get(chatId);
    if (!entry) return false;
    this._clearTimer(chatId);
    entry.timer = setTimeout(() => this._autoExit(chatId), this._autoExitMs);
    if (entry.timer.unref) entry.timer.unref();
    return true;
  }

  _autoExit(chatId) {
    const entry = this._active.get(chatId);
    if (!entry) return;
    this._active.delete(chatId);
    this._emit('plan_mode:timeout', { chatId, enteredAt: entry.enteredAt });
    this._logger.info && this._logger.info(`[PlanModeService] auto-exit chat=${chatId} tras ${this._autoExitMs}ms`);
  }

  _clearTimer(chatId) {
    const entry = this._active.get(chatId);
    if (entry && entry.timer) clearTimeout(entry.timer);
  }

  _emit(event, payload) {
    if (this._bus && typeof this._bus.emit === 'function') {
      try { this._bus.emit(event, payload); } catch {}
    }
  }

  /** Destruye todos los timers (útil en shutdown/tests). */
  shutdown() {
    for (const [chatId] of this._active) this._clearTimer(chatId);
    this._active.clear();
  }
}

PlanModeService.DEFAULT_AUTO_EXIT_MS = DEFAULT_AUTO_EXIT_MS;
module.exports = PlanModeService;
