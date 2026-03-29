'use strict';

/**
 * mcp/tools/scheduled.js — Tools MCP para acciones programadas.
 *
 * Expone: schedule_action, list_scheduled, cancel_scheduled, update_scheduled
 * Usa ctx.scheduler (server/scheduler.js).
 */

const { parseDuration } = require('../../utils/duration');
const cronParser = require('../../utils/cron-parser');

function _requireScheduler(ctx) {
  if (!ctx.scheduler) throw new Error('Módulo de acciones programadas no disponible');
}

/**
 * Resuelve el userId del creador desde el contexto.
 */
function _getCreatorId(ctx, args = {}) {
  if (ctx.userId) return ctx.userId;
  // Buscar por ctx (ConversationService) o por args (MCP HTTP — el system prompt pasa chat_id/channel)
  const chatId  = ctx.chatId  || args._creator_chat_id;
  const channel = ctx.channel || args._creator_channel || 'telegram';
  if (ctx.usersRepo && chatId) {
    const user = ctx.usersRepo.findByIdentity(channel, String(chatId));
    if (user) return user.id;
  }
  return null;
}

/**
 * Obtiene el user completo del creador (para verificar role).
 */
function _getCreatorUser(ctx, args = {}) {
  const id = _getCreatorId(ctx, args);
  if (!id || !ctx.usersRepo) return null;
  return ctx.usersRepo.getById(id);
}

/**
 * Valida que una timezone sea válida.
 */
function _isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const SCHEDULE_ACTION = {
  name: 'schedule_action',
  description: 'Programa una acción para ejecutar en el futuro. Soporta acciones únicas (fecha/hora o "en X tiempo") y recurrentes (cron). Tipos: "notification" envía texto directo, "ai_task" despierta al agente para ejecutar una tarea compleja con tools.',
  params: {
    label:           'string — descripción legible de la acción',
    action_type:     '?string — "notification" (default) o "ai_task"',
    payload:         '?string — texto del mensaje o prompt para el agente (ai_task)',
    trigger_type:    '?string — "once" (default) o "cron"',
    trigger_at:      '?string — fecha/hora ISO 8601 o epoch ms (para once)',
    delay:           '?string — alternativa a trigger_at: "30m", "2h", "1d" (para once)',
    cron_expr:       '?string — expresión cron de 5 campos: min hora día mes dow (para cron)',
    timezone:        '?string — timezone IANA (default: America/Argentina/Buenos_Aires)',
    target_type:     '?string — "self" (default), "all" (admin), "users", "whitelist" (admin), "favorites"',
    target_user_ids: '?string — JSON array de IDs de usuario (para target_type="users")',
    max_runs:        '?string — máximo de ejecuciones (null = infinito para cron)',
    agent_key:       '?string — agente a usar para ai_task',
    provider:        '?string — provider IA a usar',
    model:           '?string — modelo específico',
  },

  execute(args = {}, ctx = {}) {
    _requireScheduler(ctx);
    if (!args.label) return 'Error: parámetro label requerido';

    const creatorUser = _getCreatorUser(ctx, args);
    if (!creatorUser) return 'Error: no se pudo identificar al usuario creador. Asegurate de estar registrado.';
    const creatorId = creatorUser.id;

    // S3: target_type 'all' y 'whitelist' requieren admin
    const targetType = args.target_type || 'self';
    if ((targetType === 'all' || targetType === 'whitelist') && creatorUser.role !== 'admin') {
      return `Error: target_type "${targetType}" requiere permisos de administrador.`;
    }

    // S4: Validar timezone
    const timezone = args.timezone || 'America/Argentina/Buenos_Aires';
    if (!_isValidTimezone(timezone)) {
      return `Error: timezone inválida: "${timezone}". Usá formato IANA (ej: "America/Argentina/Buenos_Aires", "UTC").`;
    }

    const triggerType = args.trigger_type || 'once';
    let nextRunAt = null;

    if (triggerType === 'once') {
      if (args.trigger_at) {
        const parsed = Number(args.trigger_at);
        nextRunAt = isNaN(parsed) ? new Date(args.trigger_at).getTime() : parsed;
      } else if (args.delay) {
        const ms = parseDuration(args.delay);
        if (!ms) return 'Error: no se pudo parsear la duración. Ejemplos: "30m", "2h", "1d"';
        nextRunAt = Date.now() + ms;
      } else {
        return 'Error: para trigger_type="once" necesitás trigger_at o delay';
      }
      if (!nextRunAt || isNaN(nextRunAt) || nextRunAt <= Date.now()) {
        return 'Error: la fecha debe ser en el futuro';
      }
    } else if (triggerType === 'cron') {
      if (!args.cron_expr) return 'Error: para trigger_type="cron" necesitás cron_expr';
      if (!cronParser.isValid(args.cron_expr)) return `Error: expresión cron inválida: "${args.cron_expr}". Formato: min hora día mes dow`;
      const next = cronParser.getNextRun(args.cron_expr, new Date(), timezone);
      if (!next) return 'Error: no se pudo calcular la próxima ejecución para esta expresión cron';
      nextRunAt = next.getTime();
    } else {
      return `Error: trigger_type inválido: "${triggerType}". Usar "once" o "cron"`;
    }

    const action = ctx.scheduler.create(creatorId, {
      agent_key:       args.agent_key || ctx.agentKey || (ctx.scheduler && ctx.scheduler.getDefaultAgent()) || 'claude',
      provider:        args.provider || null,
      model:           args.model || null,
      action_type:     args.action_type || 'notification',
      label:           args.label,
      payload:         args.payload || args.label,
      trigger_type:    triggerType,
      trigger_at:      triggerType === 'once' ? nextRunAt : null,
      cron_expr:       args.cron_expr || null,
      timezone,
      target_type:     targetType,
      target_user_ids: args.target_user_ids || null,
      next_run_at:     nextRunAt,
      max_runs:        args.max_runs ? parseInt(args.max_runs, 10) : undefined,
    });

    if (!action) return 'Error: no se pudo crear la acción programada';

    const nextDate = new Date(nextRunAt).toISOString().slice(0, 16).replace('T', ' ');
    const cronDesc = args.cron_expr ? ` (${cronParser.describe(args.cron_expr)})` : '';

    return [
      `✅ Acción programada creada`,
      `ID: ${action.id}`,
      `Tipo: ${action.action_type}`,
      `Label: ${action.label}`,
      `Trigger: ${triggerType}${cronDesc}`,
      `Próxima ejecución: ${nextDate}`,
      `Destino: ${action.target_type}`,
    ].join('\n');
  },
};

const LIST_SCHEDULED = {
  name: 'list_scheduled',
  description: 'Lista las acciones programadas del usuario actual.',
  params: {
    all:   '?string — "true" para ver todas (solo admin)',
    limit: '?string — máximo de resultados (default 50)',
  },

  execute(args = {}, ctx = {}) {
    _requireScheduler(ctx);

    let actions;
    const limit = args.limit ? parseInt(args.limit, 10) : 50;

    if (args.all === 'true') {
      // S1: solo admin puede ver todas
      const user = _getCreatorUser(ctx, args);
      if (!user || user.role !== 'admin') return 'Error: solo administradores pueden listar todas las acciones.';
      actions = ctx.scheduler.listAll(limit);
    } else {
      const creatorId = _getCreatorId(ctx, args);
      if (!creatorId) return 'Error: no se pudo identificar al usuario.';
      actions = ctx.scheduler.list(creatorId);
    }

    if (!actions.length) return 'No hay acciones programadas.';

    const lines = actions.map((a, i) => {
      const next = a.next_run_at ? new Date(a.next_run_at).toISOString().slice(0, 16).replace('T', ' ') : 'N/A';
      const cronDesc = a.cron_expr ? ` (${cronParser.describe(a.cron_expr)})` : '';
      return [
        `${i + 1}. ${a.label}`,
        `   ID: ${a.id} | Tipo: ${a.action_type} | Status: ${a.status}`,
        `   Trigger: ${a.trigger_type}${cronDesc}`,
        `   Próxima: ${next} | Ejecutada: ${a.run_count}x`,
      ].join('\n');
    });

    return `Acciones programadas (${actions.length}):\n\n${lines.join('\n\n')}`;
  },
};

const CANCEL_SCHEDULED = {
  name: 'cancel_scheduled',
  description: 'Cancela una acción programada por su ID.',
  params: {
    id: 'string — ID de la acción a cancelar',
  },

  execute(args = {}, ctx = {}) {
    _requireScheduler(ctx);
    if (!args.id) return 'Error: parámetro id requerido';

    // S1: Verificar ownership
    const action = ctx.scheduler.getById(args.id);
    if (!action) return `Error: acción no encontrada: ${args.id}`;

    const creatorId = _getCreatorId(ctx, args);
    const user = creatorId && ctx.usersRepo ? ctx.usersRepo.getById(creatorId) : null;
    if (action.creator_id !== creatorId && user?.role !== 'admin') {
      return 'Error: no tenés permisos para cancelar esta acción.';
    }

    const ok = ctx.scheduler.cancel(args.id);
    return ok
      ? `✅ Acción cancelada: ${args.id}`
      : `Error: no se pudo cancelar: ${args.id}`;
  },
};

const UPDATE_SCHEDULED = {
  name: 'update_scheduled',
  description: 'Modifica una acción programada existente. Solo se actualizan los campos proporcionados.',
  params: {
    id:              'string — ID de la acción',
    label:           '?string',
    payload:         '?string',
    trigger_at:      '?string — nueva fecha ISO 8601 o epoch ms',
    cron_expr:       '?string — nueva expresión cron',
    target_type:     '?string',
    target_user_ids: '?string',
    status:          '?string — "active" o "paused"',
  },

  execute(args = {}, ctx = {}) {
    _requireScheduler(ctx);
    if (!args.id) return 'Error: parámetro id requerido';

    // S1: Verificar ownership
    const action = ctx.scheduler.getById(args.id);
    if (!action) return `Error: acción no encontrada: ${args.id}`;

    const creatorId = _getCreatorId(ctx, args);
    const user = creatorId && ctx.usersRepo ? ctx.usersRepo.getById(creatorId) : null;
    if (action.creator_id !== creatorId && user?.role !== 'admin') {
      return 'Error: no tenés permisos para modificar esta acción.';
    }

    const fields = {};
    if (args.label)           fields.label = args.label;
    if (args.payload)         fields.payload = args.payload;
    if (args.target_type)     fields.target_type = args.target_type;
    if (args.target_user_ids) fields.target_user_ids = args.target_user_ids;
    if (args.status)          fields.status = args.status;

    if (args.trigger_at) {
      const parsed = Number(args.trigger_at);
      fields.trigger_at = isNaN(parsed) ? new Date(args.trigger_at).getTime() : parsed;
      fields.next_run_at = fields.trigger_at;
    }

    if (args.cron_expr) {
      if (!cronParser.isValid(args.cron_expr)) return `Error: expresión cron inválida: "${args.cron_expr}"`;
      fields.cron_expr = args.cron_expr;
      const next = cronParser.getNextRun(args.cron_expr);
      if (next) fields.next_run_at = next.getTime();
    }

    const ok = ctx.scheduler.update(args.id, fields);
    return ok
      ? `✅ Acción actualizada: ${args.id}`
      : `Error: no se pudo actualizar: ${args.id}`;
  },
};

module.exports = [SCHEDULE_ACTION, LIST_SCHEDULED, CANCEL_SCHEDULED, UPDATE_SCHEDULED];
