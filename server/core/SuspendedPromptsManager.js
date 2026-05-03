'use strict';

/**
 * SuspendedPromptsManager — in-memory registry de prompts pausados esperando
 * respuesta del usuario. Una key (chatId) → una Promise pendiente.
 *
 * Fase 4 extra — soporte primitivo para `LoopRunner.suspend()` y la tool
 * `ask_user_question`.
 *
 * NO persiste a DB: un restart del server cancela todos los pendientes (los
 * Promise rechazan). Para flujos largos usar `ResumableSessionsRepository`.
 *
 * Contract:
 *   suspend({ chatId, question, options?, timeoutMs? }) → Promise<answer>
 *   resume(chatId, answer) → true si había uno pendiente, false otherwise
 *   cancel(chatId, reason?) → true si había uno pendiente
 *   getPending(chatId) → record sin Promise, o null
 *   listPending() → array de records (sin Promises)
 */

const DEFAULT_TIMEOUT_MS = 10 * 60_000; // 10 minutos

class SuspendedPromptsManager {
  constructor({ eventBus = null, logger = console } = {}) {
    this._bus = eventBus;
    this._logger = logger;
    /** @type {Map<string, { resolve, reject, timer, question, options, awaitingSince }>} */
    this._pending = new Map();
  }

  suspend({ chatId, question, options = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!chatId) return Promise.reject(new Error('chatId requerido'));
    if (!question) return Promise.reject(new Error('question requerido'));

    // Si ya hay uno pendiente, rechazar el viejo antes de reemplazar
    const existing = this._pending.get(chatId);
    if (existing) {
      try { clearTimeout(existing.timer); } catch {}
      try { existing.reject(new Error('suspended prompt superseded')); } catch {}
    }

    const awaitingSince = Date.now();
    const record = { question, options, awaitingSince };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.get(chatId) === record) {
          this._pending.delete(chatId);
          this._emit('loop:suspended_timeout', { chatId, question, awaitingSince });
          reject(new Error(`suspend timeout (${timeoutMs}ms)`));
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      record.resolve = resolve;
      record.reject = reject;
      record.timer = timer;
    });
    this._pending.set(chatId, record);
    this._emit('loop:suspended', { chatId, question, options, awaitingSince, timeoutMs });
    return promise;
  }

  resume(chatId, answer) {
    const record = this._pending.get(chatId);
    if (!record) return false;
    clearTimeout(record.timer);
    this._pending.delete(chatId);
    this._emit('loop:resumed', { chatId, question: record.question, awaitingSince: record.awaitingSince });
    try { record.resolve(answer); } catch {}
    return true;
  }

  cancel(chatId, reason = 'cancelled') {
    const record = this._pending.get(chatId);
    if (!record) return false;
    clearTimeout(record.timer);
    this._pending.delete(chatId);
    this._emit('loop:suspended_cancelled', { chatId, reason });
    try { record.reject(new Error(reason)); } catch {}
    return true;
  }

  getPending(chatId) {
    const r = this._pending.get(chatId);
    if (!r) return null;
    return { chatId, question: r.question, options: r.options, awaitingSince: r.awaitingSince };
  }

  listPending() {
    return Array.from(this._pending.entries()).map(([chatId, r]) => ({
      chatId, question: r.question, options: r.options, awaitingSince: r.awaitingSince,
    }));
  }

  hasPending(chatId) {
    return this._pending.has(chatId);
  }

  _emit(event, payload) {
    if (this._bus && typeof this._bus.emit === 'function') {
      try { this._bus.emit(event, payload); } catch (err) {
        this._logger.warn && this._logger.warn(`[SuspendedPromptsManager] emit ${event} falló: ${err.message}`);
      }
    }
  }
}

module.exports = SuspendedPromptsManager;
