'use strict';

/**
 * mcp/tools/cron.js — tools MCP para manejar crons propios del modelo.
 *
 * Wrapper liviano sobre `scheduler.js` + `ScheduledActionsRepository`.
 * Enforcement de cuotas via `JobQuotaService` (Fase 9).
 *
 * Tools:
 *   - `cron_create` — programa un cron recurrente
 *   - `cron_list`   — lista crons del usuario
 *   - `cron_delete` — elimina un cron por id
 *
 * Scope: por `userId` (resuelto de ctx). Admin aproval para cron < 1min
 * (gated por `JobQuotaService.canCreate` con `isAdmin`).
 */

const { resolveUserId, isAdmin } = require('./user-sandbox');

const CREATE = {
  name: 'cron_create',
  description: 'Programa un cron recurrente. cron_expr en formato estándar (5 campos: "minuto hora dia_mes mes dia_sem"). label y payload describen la acción a ejecutar al dispararse. Admin aproval para intervalos < 60s.',
  params: {
    cron_expr: 'string',
    label:     'string',
    payload:   '?string',
    agent_key: '?string',
    timezone:  '?string',
  },
  execute(args = {}, ctx = {}) {
    if (!ctx.scheduler || !ctx.scheduler._actionsRepo) return 'Error: scheduler no disponible';
    if (!ctx.jobQuotaService) return 'Error: jobQuotaService no disponible';
    if (!args.cron_expr) return 'Error: cron_expr requerido';
    if (!args.label)     return 'Error: label requerido';

    const userId = resolveUserId(ctx);
    if (!userId) return 'Error: no se pudo resolver userId';

    const quota = ctx.jobQuotaService.canCreate({
      userId, cronExpr: args.cron_expr, isAdmin: isAdmin(ctx),
    });
    if (!quota.allowed) return `Error: ${quota.reason}`;

    try {
      const action = ctx.scheduler._actionsRepo.create({
        creator_id:   userId,
        agent_key:    args.agent_key || ctx.agentKey || 'claude',
        action_type:  'ai_task',
        label:        args.label,
        payload:      args.payload || null,
        trigger_type: 'cron',
        cron_expr:    args.cron_expr,
        timezone:     args.timezone || 'America/Argentina/Buenos_Aires',
        target_type:  'self',
        max_runs:     null,
      });
      if (!action) return 'Error: no se pudo crear el cron';
      return `Cron creado (id=${action.id}, expr="${args.cron_expr}", label="${args.label}")`;
    } catch (err) {
      return `Error creando cron: ${err.message}`;
    }
  },
};

const LIST = {
  name: 'cron_list',
  description: 'Lista crons del usuario actual. Retorna id, label, cron_expr, status.',
  params: {},
  execute(_args = {}, ctx = {}) {
    if (!ctx.scheduler || !ctx.scheduler._actionsRepo) return 'Error: scheduler no disponible';
    const userId = resolveUserId(ctx);
    if (!userId) return 'Error: no se pudo resolver userId';

    const rows = ctx.scheduler._actionsRepo.listByCreator(userId)
      .filter(r => r.trigger_type === 'cron');
    if (!rows.length) return '(sin crons)';
    return rows.map(r => `- #${r.id} [${r.status}] "${r.label}" — ${r.cron_expr}`).join('\n');
  },
};

const DELETE = {
  name: 'cron_delete',
  description: 'Elimina un cron por id. Solo el dueño (o admin) puede eliminar.',
  params: { id: 'string' },
  execute(args = {}, ctx = {}) {
    if (!ctx.scheduler || !ctx.scheduler._actionsRepo) return 'Error: scheduler no disponible';
    if (!args.id) return 'Error: id requerido';
    const userId = resolveUserId(ctx);
    if (!userId) return 'Error: no se pudo resolver userId';

    const action = ctx.scheduler._actionsRepo.getById(String(args.id));
    if (!action) return `Error: cron #${args.id} no encontrado`;
    if (action.creator_id !== userId && !isAdmin(ctx)) {
      return `Error: no sos dueño del cron #${args.id}`;
    }
    const ok = ctx.scheduler._actionsRepo.remove(String(args.id));
    return ok ? `Eliminado cron #${args.id}` : `Error: no se eliminó cron #${args.id}`;
  },
};

module.exports = [CREATE, LIST, DELETE];
