'use strict';

/**
 * mcp/tools/notify.js — tool `push_notification`.
 *
 * Emite un evento `notification:push` al EventBus. Los canales (telegram,
 * webchat, p2p) se suscriben a ese evento y entregan al usuario objetivo.
 *
 * Cross-cutting (consistente con los demás tools):
 *   - No hace I/O a redes/telegram directamente (lo hace el channel listener).
 *   - Respeta quiet hours si están configuradas vía chatSettings.
 *
 * Channels válidos: 'auto' (el canal activo del chat) | 'telegram' | 'webchat'.
 * Si el canal no está disponible, el listener del canal logea warning sin romper.
 */

const { resolveUserId } = require('./user-sandbox');

const QUIET_DEFAULT_START = 22; // 22:00 local
const QUIET_DEFAULT_END   = 8;  // 08:00 local

function _isQuietHour(now = new Date(), start = QUIET_DEFAULT_START, end = QUIET_DEFAULT_END) {
  const h = now.getHours();
  if (start < end) return h >= start && h < end;
  return h >= start || h < end; // wrap en midnight (22-8)
}

const PUSH_NOTIFICATION = {
  name: 'push_notification',
  description: 'Envía una notificación al canal activo del usuario. title + body. Opcional: channel específico. Respeta quiet hours.',
  params: {
    title:   'string',
    body:    'string',
    channel: '?string',
    urgent:  '?boolean',
  },
  execute(args = {}, ctx = {}) {
    if (!args.title) return 'Error: title requerido';
    if (!args.body)  return 'Error: body requerido';
    if (!ctx.eventBus || typeof ctx.eventBus.emit !== 'function') return 'Error: eventBus no disponible';

    const userId = resolveUserId(ctx) || null;
    const channel = args.channel || 'auto';
    const urgent = args.urgent === true;

    // Quiet hours: si NO urgente y estamos en horario silencioso, no emitir.
    // Se podría persistir el mensaje para enviar al salir del quiet; parked para cuando
    // haya persistencia de "notificaciones pendientes" (Fase 12 session sharing).
    if (!urgent && _isQuietHour()) {
      return 'Notificación omitida (quiet hours). Reintentá con urgent:true si es crítico.';
    }

    const payload = {
      title: String(args.title).slice(0, 200),
      body:  String(args.body).slice(0, 2000),
      channel,
      urgent,
      chatId:   ctx.chatId || null,
      userId,
      agentKey: ctx.agentKey || null,
      timestamp: Date.now(),
    };

    try { ctx.eventBus.emit('notification:push', payload); }
    catch (err) { return `Error emitiendo notificación: ${err.message}`; }

    return `Notificación enviada (channel=${channel}${urgent ? ', urgent' : ''})`;
  },
};

module.exports = [PUSH_NOTIFICATION];
module.exports._internal = { _isQuietHour };
