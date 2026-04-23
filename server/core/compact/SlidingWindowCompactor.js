'use strict';

/**
 * SlidingWindowCompactor — wrapper del comportamiento legacy (_compactHistory).
 *
 * Se incluye en el pipeline como **fallback** — corre solo si ni reactive ni micro
 * dispararon. Resume los primeros N mensajes con el mismo provider/model de la conv.
 *
 * Flag `SLIDING_WINDOW_COMPACT_ENABLED=true` por default (retrocompat con el shim actual).
 *
 * Fase 7.5.4 migrará el provider/model del summary a tier `cheap`.
 */

const ContextCompactor = require('./ContextCompactor');

const DEFAULTS = Object.freeze({
  maxMessages:       30,
  messagesToSummarize: 20,
  summaryMarker:     '[resumen-conversacion]',
});

class SlidingWindowCompactor extends ContextCompactor {
  /**
   * @param {object} deps
   * @param {function} deps.summarize         — async fn(messages, {apiKey, model, provider}) → string
   * @param {object}   [deps.logger]
   * @param {number}   [deps.maxMessages]
   * @param {number}   [deps.messagesToSummarize]
   * @param {string}   [deps.summaryMarker]
   */
  constructor({ summarize, logger = console, maxMessages, messagesToSummarize, summaryMarker } = {}) {
    super();
    if (typeof summarize !== 'function') {
      throw new Error('SlidingWindowCompactor: summarize(messages, opts)→string requerido');
    }
    this._summarize = summarize;
    this._logger = logger;
    this._maxMessages = Number.isFinite(maxMessages) ? maxMessages : DEFAULTS.maxMessages;
    this._messagesToSummarize = Number.isFinite(messagesToSummarize) ? messagesToSummarize : DEFAULTS.messagesToSummarize;
    this._summaryMarker = summaryMarker || DEFAULTS.summaryMarker;
  }

  shouldCompact(state) {
    if (!state) return false;
    const size = Number.isFinite(state.historySize)
      ? state.historySize
      : (Array.isArray(state.history) ? state.history.length : 0);
    return size > this._maxMessages;
  }

  async compact(history, ctx = {}) {
    if (!Array.isArray(history) || history.length <= this._maxMessages) return history;

    const toSummarize = history.slice(0, this._messagesToSummarize);
    const toKeep = history.slice(this._messagesToSummarize);

    let summary;
    try {
      summary = await this._summarize(toSummarize, {
        apiKey:   ctx.apiKey,
        model:    ctx.model,
        provider: ctx.provider,
        source:   'sliding_window_compact',
      });
    } catch (err) {
      this._logger.warn && this._logger.warn(`[SlidingWindowCompactor] summarize falló: ${err.message}; retornando history sin tocar`);
      return history;
    }

    if (!summary || !String(summary).trim()) {
      return history;
    }

    const summaryMsg = { role: 'user', content: `${this._summaryMarker}\nResumen de conversación anterior:\n${summary}` };
    const ackMsg    = { role: 'assistant', content: 'Entendido, tengo el contexto de la conversación anterior.' };
    return [summaryMsg, ackMsg, ...toKeep];
  }
}

SlidingWindowCompactor.DEFAULTS = DEFAULTS;
module.exports = SlidingWindowCompactor;
