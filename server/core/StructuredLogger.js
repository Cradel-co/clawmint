'use strict';

/**
 * StructuredLogger — wrapper sobre `core/Logger.js` que agrega:
 *   - output JSON (opcional via `LOG_FORMAT=json`)
 *   - contexto heredable: correlationId + campos arbitrarios
 *   - `child({field: val})` crea un logger con contexto extra
 *
 * No reemplaza al Logger base — lo envuelve. El Logger sigue siendo responsable
 * de rotación, archivo destino, toggle enabled. Este layer solo agrega estructura.
 *
 * Uso:
 *   const slog = new StructuredLogger({ logger });           // root
 *   slog.info('server started', { port: 3000 });
 *   const chatLog = slog.child({ chatId: 'abc', correlationId: 'req-1' });
 *   chatLog.info('message received');
 *   // → {"ts":"...","level":"info","msg":"message received","chatId":"abc","correlationId":"req-1"}
 */

function _jsonSafe(o) {
  if (!o || typeof o !== 'object') return o;
  // Evitar circular refs via JSON.stringify directo
  try { return JSON.parse(JSON.stringify(o)); }
  catch { return String(o); }
}

class StructuredLogger {
  /**
   * @param {object} opts
   * @param {object} opts.logger                  — Logger base (core/Logger.js o console)
   * @param {object} [opts.context]               — contexto base (se hereda en child())
   * @param {'json'|'text'} [opts.format]         — override; default lee LOG_FORMAT env
   */
  constructor({ logger, context = {}, format } = {}) {
    if (!logger || typeof logger.info !== 'function') {
      throw new Error('StructuredLogger: logger con .info() requerido');
    }
    this._logger = logger;
    this._context = Object.freeze({ ...context });
    this._format = format || (process.env.LOG_FORMAT === 'json' ? 'json' : 'text');
  }

  /** Retorna un logger nuevo con contexto extra merged al actual. */
  child(extraContext) {
    const ctx = { ...this._context, ...(extraContext || {}) };
    return new StructuredLogger({ logger: this._logger, context: ctx, format: this._format });
  }

  /** Atajo común: setear correlationId. */
  withCorrelationId(id) {
    return this.child({ correlationId: id });
  }

  info(msg, extra)  { this._emit('info', msg, extra); }
  warn(msg, extra)  { this._emit('warn', msg, extra); }
  error(msg, extra) { this._emit('error', msg, extra); }
  debug(msg, extra) {
    if (process.env.DEBUG === '1' || process.env.LOG_LEVEL === 'debug') {
      this._emit('debug', msg, extra);
    }
  }

  _emit(level, msg, extra) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      msg: typeof msg === 'string' ? msg : _jsonSafe(msg),
      ...this._context,
      ...(extra && typeof extra === 'object' ? _jsonSafe(extra) : {}),
    };

    if (this._format === 'json') {
      const line = JSON.stringify(payload);
      // Logger base toma strings; le paso la línea JSON completa como mensaje
      if (level === 'error') this._logger.error(line);
      else if (level === 'warn') this._logger.warn(line);
      else this._logger.info(line);
    } else {
      // Formato texto: mensaje + pares key=value ordenados
      const kv = Object.entries(payload)
        .filter(([k]) => !['ts', 'level', 'msg'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      const text = kv ? `${payload.msg} ${kv}` : String(payload.msg);
      if (level === 'error') this._logger.error(text);
      else if (level === 'warn') this._logger.warn(text);
      else this._logger.info(text);
    }
  }

  /** Acceso al contexto actual (solo lectura). */
  get context() { return this._context; }
}

module.exports = StructuredLogger;
