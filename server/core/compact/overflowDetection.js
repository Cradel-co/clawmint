'use strict';

/**
 * overflowDetection — clasifica errors de providers LLM por tipo "overflow de contexto".
 *
 * Cuando un provider devuelve un error de este tipo, el LoopRunner puede disparar
 * compactación retroactiva y re-intentar en vez de dar up directo.
 *
 * Patterns extraídos de OpenCode (`packages/opencode/src/provider/error.ts`) + Claude Code.
 * Si aparecen patrones nuevos en producción, agregarlos acá y sumar un test.
 */

const OVERFLOW_PATTERNS = Object.freeze([
  /prompt is too long/i,                           // Anthropic
  /exceeds? the context window/i,                  // OpenAI / OpenAI-compatible
  /maximum context length is \d+/i,                // xAI
  /context_length_exceeded/i,                      // OpenAI code
  /input length and `max_tokens` exceed/i,         // Anthropic específico
  /reduce the length of the messages/i,            // OpenAI
  /token limit (exceeded|reached)/i,               // genérico
  /messages? too long/i,                           // Gemini
  /request is too large/i,                         // genérico
  /content too long/i,                             // xAI variation
  /context window.*exceeded/i,                     // variante
  /too many tokens/i,                              // DeepSeek variation
  /input_tokens.*exceeds/i,                        // Anthropic variant
]);

/**
 * @param {Error|string|object} error
 * @returns {boolean}
 */
function isOverflowError(error) {
  if (!error) return false;
  const msg = typeof error === 'string'
    ? error
    : (error.message || String(error));
  return OVERFLOW_PATTERNS.some(p => p.test(msg));
}

/**
 * Extrae un hint del max_tokens permitido para retry, si lo detecta en el mensaje.
 * Claude Code hace esto para re-sumar y pedir con nuevo max_tokens más bajo.
 * @param {Error|string|object} error
 * @returns {number|null}
 */
function extractMaxTokensHint(error) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : (error.message || String(error));
  // Patrones: "input length and `max_tokens` exceed context limit: 175000 + 32000 > 200000"
  const m = msg.match(/(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/);
  if (m) {
    const input = parseInt(m[1], 10);
    const context = parseInt(m[3], 10);
    if (Number.isFinite(input) && Number.isFinite(context) && context > input) {
      return Math.max(0, context - input - 1000); // 1000 token buffer
    }
  }
  // "maximum context length is 128000 tokens"
  const m2 = msg.match(/maximum context length is (\d+)/i);
  if (m2) {
    const ctx = parseInt(m2[1], 10);
    return Number.isFinite(ctx) ? ctx : null;
  }
  return null;
}

module.exports = {
  OVERFLOW_PATTERNS,
  isOverflowError,
  extractMaxTokensHint,
};
