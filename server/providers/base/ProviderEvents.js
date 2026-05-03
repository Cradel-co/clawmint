'use strict';

/**
 * ProviderEvents — tipos canónicos emitidos por los providers v2.
 *
 * Los providers v2 son async generators que yieldan estos eventos.
 * LoopRunner / ConversationService los consume uniformemente, sin importar el SDK subyacente.
 *
 * Los providers legacy (v1) emiten un subconjunto: text, tool_call, tool_result, usage, done.
 * legacyShim.js traduce automáticamente v1 → v2.
 */

const EVENT_TYPES = Object.freeze({
  // Texto plano del modelo (chunk por chunk)
  TEXT_DELTA:       'text_delta',

  // Bloque de thinking (extended thinking en Anthropic)
  THINKING_DELTA:   'thinking_delta',

  // Tool call — ciclo de vida: start → delta* → end
  TOOL_CALL_START:  'tool_call_start',  // { id, name, index }
  TOOL_CALL_DELTA:  'tool_call_delta',  // { id, argsJsonDelta }  — fragmentos de args JSON
  TOOL_CALL_END:    'tool_call_end',    // { id, name, args, argsError? }

  // Resultado de ejecución de tool (emitido por LoopRunner tras ejecutar)
  TOOL_RESULT:      'tool_result',      // { id, name, result, isError }

  // Estadísticas de cache (Anthropic prompt caching)
  CACHE_STATS:      'cache_stats',      // { creation, read }

  // Uso de tokens
  USAGE:            'usage',            // { promptTokens, completionTokens }

  // Terminal — fin del turno del provider
  DONE:             'done',             // { fullText, stopReason }

  // Error estructurado
  ERROR:            'error',            // { code, message, retryable }

  // Eventos que solo emite LoopRunner (no un provider directamente)
  SYSTEM_REMINDER:  'system_reminder',  // { text } — inyectado por skills
});

/** stopReason posibles en `done` */
const STOP_REASON = Object.freeze({
  END_TURN:      'end_turn',      // modelo terminó normalmente
  TOOL_USE:      'tool_use',      // pidió ejecutar tool(s)
  MAX_TOKENS:    'max_tokens',    // cortado por límite
  STOP_SEQUENCE: 'stop_sequence', // matched stop sequence
  REFUSAL:       'refusal',       // safety refusal (Anthropic)
  PAUSE_TURN:    'pause_turn',    // pausa para más tool results
  ERROR:         'error',         // abortó por error
  CANCELLED:     'cancelled',     // abortó por AbortSignal
});

/** Factories para construir eventos bien formados */
const make = Object.freeze({
  textDelta:      (text)                       => ({ type: EVENT_TYPES.TEXT_DELTA, text }),
  thinkingDelta:  (text)                       => ({ type: EVENT_TYPES.THINKING_DELTA, text }),
  toolCallStart:  (id, name, index = 0)        => ({ type: EVENT_TYPES.TOOL_CALL_START, id, name, index }),
  toolCallDelta:  (id, argsJsonDelta)          => ({ type: EVENT_TYPES.TOOL_CALL_DELTA, id, argsJsonDelta }),
  toolCallEnd:    (id, name, args, argsError)  => {
    const ev = { type: EVENT_TYPES.TOOL_CALL_END, id, name, args };
    if (argsError) ev.argsError = argsError;
    return ev;
  },
  toolResult:     (id, name, result, isError = false) => ({ type: EVENT_TYPES.TOOL_RESULT, id, name, result, isError }),
  cacheStats:     (creation, read)             => ({ type: EVENT_TYPES.CACHE_STATS, creation, read }),
  usage:          (promptTokens, completionTokens) => ({ type: EVENT_TYPES.USAGE, promptTokens, completionTokens }),
  done:           (fullText, stopReason = STOP_REASON.END_TURN) => ({ type: EVENT_TYPES.DONE, fullText, stopReason }),
  error:          (code, message, retryable = false) => ({ type: EVENT_TYPES.ERROR, code, message, retryable }),
  systemReminder: (text)                       => ({ type: EVENT_TYPES.SYSTEM_REMINDER, text }),
});

/** Valida que un evento tenga forma conocida */
function isValidEvent(ev) {
  if (!ev || typeof ev !== 'object' || !ev.type) return false;
  return Object.values(EVENT_TYPES).includes(ev.type);
}

module.exports = { EVENT_TYPES, STOP_REASON, make, isValidEvent };
