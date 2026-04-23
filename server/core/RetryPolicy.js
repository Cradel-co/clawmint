'use strict';

/**
 * RetryPolicy — decide si reintentar y con qué delay.
 *
 * Responsabilidad única: clasificar errores y calcular backoff.
 * No conoce providers, no emite eventos, no tiene estado — funciones puras.
 *
 * Uso:
 *   const policy = new RetryPolicy({ maxRetries: 3 });
 *   const decision = policy.shouldRetry({ errorMessage: '429 Too Many Requests', attempt: 0, usedTools: false });
 *   // → { retry: true, delayMs: 1234, reason: 'transient:rate_limit' }
 */

const TRANSIENT_PATTERNS = [
  { regex: /timeout/i,               tag: 'transient:timeout' },
  { regex: /429|rate.?limit/i,       tag: 'transient:rate_limit' },
  { regex: /5\d\d\b/,                tag: 'transient:5xx' },
  { regex: /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH/i, tag: 'transient:network' },
  { regex: /socket hang up/i,        tag: 'transient:network' },
  { regex: /overloaded/i,            tag: 'transient:overloaded' },
];

// D5 — errores recuperables que requieren acción previa al retry (auto-compact).
// Distintos de transient: el retry solo funciona si primero se compacta el context.
const RECOVERABLE_PATTERNS = [
  { regex: /prompt.{0,12}too.{0,4}long/i,                     tag: 'recoverable:context_exceeded' },
  { regex: /prompt_too_long/i,                                tag: 'recoverable:context_exceeded' },
  { regex: /request too large/i,                              tag: 'recoverable:context_exceeded' },
  { regex: /context.{0,4}length.{0,4}exceeded/i,              tag: 'recoverable:context_exceeded' },
  { regex: /context_length_exceeded/i,                        tag: 'recoverable:context_exceeded' },
  { regex: /messages.*(?:too long|exceeds)/i,                 tag: 'recoverable:context_exceeded' },
  { regex: /input.*exceeds.*max/i,                            tag: 'recoverable:context_exceeded' },
];

class RetryPolicy {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxRetries=3]          total intentos incluyendo el primero
   * @param {number} [opts.baseDelayMs=1000]      delay inicial
   * @param {number} [opts.maxDelayMs=30000]      cap superior del delay
   * @param {number} [opts.jitterMs=500]          jitter aleatorio sumado al delay
   */
  constructor(opts = {}) {
    this.maxRetries  = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 3;
    this.baseDelayMs = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : 1000;
    this.maxDelayMs  = Number.isFinite(opts.maxDelayMs) ? opts.maxDelayMs : 30_000;
    this.jitterMs    = Number.isFinite(opts.jitterMs) ? opts.jitterMs : 500;
  }

  /**
   * Clasifica un mensaje de error.
   * @param {string} errorMessage
   * @returns {{ transient: boolean, tag: string }}
   */
  classify(errorMessage) {
    const msg = String(errorMessage || '');
    for (const { regex, tag } of RECOVERABLE_PATTERNS) {
      if (regex.test(msg)) return { transient: true, recoverable: true, tag };
    }
    for (const { regex, tag } of TRANSIENT_PATTERNS) {
      if (regex.test(msg)) return { transient: true, recoverable: false, tag };
    }
    return { transient: false, recoverable: false, tag: 'permanent' };
  }

  /**
   * Decide si reintentar.
   * @param {object} opts
   * @param {string} opts.errorMessage
   * @param {number} opts.attempt       0-indexed
   * @param {boolean} opts.usedTools    side effects ya ejecutados → no reintentar
   * @returns {{ retry: boolean, delayMs: number, reason: string }}
   */
  shouldRetry({ errorMessage, attempt, usedTools }) {
    if (usedTools) {
      return { retry: false, delayMs: 0, reason: 'tools_already_executed' };
    }
    if (attempt + 1 >= this.maxRetries) {
      return { retry: false, delayMs: 0, reason: 'max_retries_reached' };
    }
    const { transient, recoverable, tag } = this.classify(errorMessage);
    if (!transient) {
      return { retry: false, delayMs: 0, reason: tag };
    }
    const exponential = Math.pow(2, attempt) * this.baseDelayMs;
    const jitter = Math.random() * this.jitterMs;
    const delayMs = Math.min(exponential + jitter, this.maxDelayMs);
    // D5 — para recoverable (prompt_too_long), el caller debe compactar antes de retry
    return { retry: true, delayMs, reason: tag, recoverable: !!recoverable };
  }
}

module.exports = RetryPolicy;
