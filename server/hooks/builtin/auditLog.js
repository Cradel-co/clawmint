'use strict';

/**
 * auditLog — hook handler built-in que registra cada tool_use al logger.
 *
 * Uso via JsExecutor:
 *   jsExecutor.registerHandler('audit_log', auditLogHandler({ logger }))
 *   hookRegistry.register({
 *     event: 'post_tool_use',
 *     handlerType: 'js',
 *     handlerRef: 'audit_log',
 *     scopeType: 'global',
 *   })
 *
 * Observa el resultado (no lo muta). No retorna block/replace — pasa transparente.
 */

function auditLogHandler({ logger = console } = {}) {
  return async function auditLog(payload, opts = {}) {
    const { name, args, result, agentKey, userId } = payload || {};
    const ctx = (opts && opts.ctx) || {};
    const line = {
      event: 'tool_use',
      tool: name,
      agent: agentKey || null,
      user: userId || null,
      chat: ctx.chatId || null,
      channel: ctx.channel || null,
      args_keys: args && typeof args === 'object' ? Object.keys(args) : [],
      result_len: typeof result === 'string' ? result.length : undefined,
      ts: Date.now(),
    };
    logger.info(`[audit] ${JSON.stringify(line)}`);
    return null; // transparente, sin block/replace
  };
}

module.exports = { auditLogHandler };
