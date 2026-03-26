'use strict';

/**
 * OutboundQueue — rate limiter para la API de Telegram con retry en 429.
 *
 * Límites de Telegram:
 * - 30 mensajes/segundo global por bot
 * - 20 mensajes/minuto por chat en grupos
 * - 1 mensaje/segundo por chat (recomendado)
 *
 * Estrategia: token bucket global (30/s) + per-chat (1/s).
 * Retry automático en 429 con backoff del retry_after de Telegram.
 */
class OutboundQueue {
  constructor({
    globalRate    = 30,    // máx calls/segundo global
    perChatRate   = 1,     // máx calls/segundo por chat
    maxRetries    = 3,     // reintentos en 429
    logger        = console,
  } = {}) {
    this._globalRate   = globalRate;
    this._perChatRate  = perChatRate;
    this._maxRetries   = maxRetries;
    this._logger       = logger;

    // Token bucket global: timestamps de las últimas N llamadas
    this._globalWindow = [];

    // Per-chat: último timestamp de envío
    this._chatLastSend = new Map();

    // Cola de requests pendientes
    this._queue   = [];
    this._running = false;
  }

  /**
   * Encolar una llamada a la API de Telegram.
   * @param {Function} apiFn - función async que ejecuta la llamada HTTP
   * @param {string|number|null} chatId - chatId para rate limit per-chat (null = sin limit per-chat)
   * @returns {Promise<any>} resultado de la API
   */
  enqueue(apiFn, chatId = null) {
    return new Promise((resolve, reject) => {
      this._queue.push({ apiFn, chatId, resolve, reject, retries: 0 });
      this._processQueue();
    });
  }

  async _processQueue() {
    if (this._running) return;
    this._running = true;

    while (this._queue.length > 0) {
      const item = this._queue[0];

      // Esperar si excede rate global
      const globalWait = this._getGlobalWait();
      if (globalWait > 0) {
        await this._sleep(globalWait);
        continue;
      }

      // Esperar si excede rate per-chat
      if (item.chatId != null) {
        const chatWait = this._getChatWait(item.chatId);
        if (chatWait > 0) {
          // No bloquear toda la cola: sacar este item, procesar otro, re-encolar
          const deferred = this._queue.shift();
          const reinsertIdx = this._findNextSlot(deferred.chatId);
          this._queue.splice(reinsertIdx, 0, deferred);
          // Si todos los items en cola son del mismo chat, toca esperar
          if (reinsertIdx === 0) {
            await this._sleep(chatWait);
          }
          continue;
        }
      }

      // Sacar de la cola y ejecutar
      this._queue.shift();
      this._recordGlobal();
      if (item.chatId != null) this._recordChat(item.chatId);

      try {
        const result = await item.apiFn();
        item.resolve(result);
      } catch (err) {
        // Retry en 429 (Too Many Requests)
        if (this._is429(err) && item.retries < this._maxRetries) {
          const retryAfter = this._parseRetryAfter(err) || (2 ** item.retries);
          this._logger.error(`[OutboundQueue] 429 — retry #${item.retries + 1} en ${retryAfter}s`);
          item.retries++;
          // Re-encolar al frente después del delay
          await this._sleep(retryAfter * 1000);
          this._queue.unshift(item);
        } else {
          item.reject(err);
        }
      }
    }

    this._running = false;
  }

  // ── Rate limit helpers ──────────────────────────────────────────────────

  _getGlobalWait() {
    const now = Date.now();
    // Limpiar entradas viejas (>1s)
    while (this._globalWindow.length > 0 && now - this._globalWindow[0] > 1000) {
      this._globalWindow.shift();
    }
    if (this._globalWindow.length >= this._globalRate) {
      return this._globalWindow[0] + 1000 - now + 1;
    }
    return 0;
  }

  _recordGlobal() {
    this._globalWindow.push(Date.now());
  }

  _getChatWait(chatId) {
    const last = this._chatLastSend.get(chatId);
    if (!last) return 0;
    const interval = 1000 / this._perChatRate;
    const elapsed = Date.now() - last;
    return elapsed < interval ? interval - elapsed + 1 : 0;
  }

  _recordChat(chatId) {
    this._chatLastSend.set(chatId, Date.now());
    // Limpiar entries viejas periódicamente
    if (this._chatLastSend.size > 1000) {
      const cutoff = Date.now() - 60000;
      for (const [id, ts] of this._chatLastSend) {
        if (ts < cutoff) this._chatLastSend.delete(id);
      }
    }
  }

  /**
   * Buscar el siguiente slot en la cola que NO sea del mismo chatId.
   * Si no hay, retorna 0 (se queda al frente).
   */
  _findNextSlot(chatId) {
    for (let i = 0; i < this._queue.length; i++) {
      if (this._queue[i].chatId !== chatId) return i;
    }
    return 0;
  }

  // ── 429 helpers ─────────────────────────────────────────────────────────

  _is429(err) {
    const msg = err?.message || '';
    return msg.includes('Too Many Requests') || msg.includes('retry after') || msg.includes('429');
  }

  _parseRetryAfter(err) {
    const msg = err?.message || '';
    const match = msg.match(/retry after (\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  get pending() { return this._queue.length; }

  get stats() {
    return {
      pending:     this._queue.length,
      activeChats: this._chatLastSend.size,
      processing:  this._running,
    };
  }
}

module.exports = OutboundQueue;
