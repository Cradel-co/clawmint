'use strict';

/**
 * mcp/tools/routines.js — wrapper user-friendly sobre Scheduler para rutinas
 * proactivas (morning brief, bedtime brief, alertas climáticas).
 *
 * El user no debería escribir cron expressions; usa estas tools de alto nivel:
 *   - routine_morning_set({ time: "07:30" })
 *   - routine_bedtime_set({ time: "22:00" })
 *   - routine_weather_alert({ rain_threshold: 60 })
 *   - routine_disable({ type: "morning" })
 *   - routine_list()
 *
 * Cada rutina genera 1 scheduled_action con cron derivado del time. El id del
 * action queda guardado en userPreferences key `routine:<type>:action_id` para
 * poder eliminarlo/regenerarlo idempotentemente.
 */

const { resolveUserId } = require('./user-sandbox');

const ROUTINE_PAYLOADS = {
  morning:  'Generá un morning brief usando la tool morning_brief y enviá el resultado al user actual via el canal disponible (telegram_send_message si tiene chatId, sino webchat).',
  bedtime:  'Generá un bedtime brief usando la tool bedtime_brief y enviá el resultado al user actual via el canal disponible.',
  weather_alert: 'Consultá weather_get para los próximos 2 días. Si la probabilidad de lluvia es >= {threshold}%, enviá una alerta corta al user via el canal disponible. Si no hay riesgo, no envíes nada.',
};

function _validateTime(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]); const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { hour: h, minute: mm };
}

function _cronFor(t, days) {
  // days: '*' o CSV de 0-6 (domingo=0). Default '*'.
  const dow = days || '*';
  return `${t.minute} ${t.hour} * * ${dow}`;
}

function _prefKey(type) { return `routine:${type}:action_id`; }

function _err(msg) { return JSON.stringify({ error: msg }); }
function _ok(p)    { return JSON.stringify(p, null, 2); }

/** Helper común: borra rutina existente y crea nueva con cron derivado del time. */
function _setRoutine(type, args, ctx) {
  if (!ctx.scheduler?._actionsRepo) return _err('scheduler no disponible');
  if (!ctx.userPreferencesRepo) return _err('userPreferencesRepo no disponible');
  const userId = resolveUserId(ctx);
  if (!userId) return _err('No se pudo resolver userId');

  const time = _validateTime(args.time);
  if (!time) return _err('Pasá `time` en formato HH:MM (ej. "07:30").');

  const days = args.days || '*';
  const cronExpr = _cronFor(time, days);
  const tz = args.timezone || 'America/Argentina/Buenos_Aires';

  // Eliminar rutina previa si existe
  const prevId = ctx.userPreferencesRepo.get(userId, _prefKey(type));
  if (prevId) {
    try { ctx.scheduler._actionsRepo.delete(prevId); } catch {}
    ctx.userPreferencesRepo.remove(userId, _prefKey(type));
  }

  // Si type=disable mode, salimos sin crear
  if (args._removeOnly) return _ok({ ok: true, removed: prevId || null });

  // Construir payload — sustituir placeholders ({threshold} para weather_alert)
  let payload = ROUTINE_PAYLOADS[type];
  if (type === 'weather_alert' && args.rain_threshold != null) {
    payload = payload.replace('{threshold}', String(args.rain_threshold));
  }

  let action;
  try {
    action = ctx.scheduler._actionsRepo.create({
      creator_id:   userId,
      agent_key:    args.agent_key || ctx.agentKey || 'claude',
      action_type:  'ai_task',
      label:        `Rutina: ${type}`,
      payload,
      trigger_type: 'cron',
      cron_expr:    cronExpr,
      timezone:     tz,
      target_type:  'self',
      max_runs:     null,
    });
  } catch (err) {
    return _err(`No pude crear la rutina: ${err.message}`);
  }

  if (!action) return _err('No pude crear la rutina');

  ctx.userPreferencesRepo.set(userId, _prefKey(type), action.id);
  return _ok({
    ok: true,
    type,
    action_id: action.id,
    cron_expr: cronExpr,
    time: args.time,
    days,
    timezone: tz,
  });
}

const ROUTINE_MORNING_SET = {
  name: 'routine_morning_set',
  description: 'Configura un morning brief automático para el usuario actual. A la hora indicada cada día, el agente genera y envía el brief proactivamente. Reemplaza la rutina previa si existía.',
  params: {
    time: 'string',         // "07:30"
    days: '?string',        // "*" o CSV "1,2,3,4,5" (lunes a viernes). Default "*".
    timezone: '?string',    // default America/Argentina/Buenos_Aires
  },
  execute(args, ctx) { return _setRoutine('morning', args, ctx); },
};

const ROUTINE_BEDTIME_SET = {
  name: 'routine_bedtime_set',
  description: 'Configura un bedtime brief automático (cierre del día + qué viene mañana). Mismo formato que routine_morning_set.',
  params: {
    time: 'string',
    days: '?string',
    timezone: '?string',
  },
  execute(args, ctx) { return _setRoutine('bedtime', args, ctx); },
};

const ROUTINE_WEATHER_ALERT = {
  name: 'routine_weather_alert',
  description: 'Configura una alerta automática diaria si el clima del día siguiente tiene >= rain_threshold% de probabilidad de lluvia. Solo envía mensaje si hay riesgo (no spammea).',
  params: {
    time: 'string',           // "20:00"
    rain_threshold: '?number', // default 60
    days: '?string',
    timezone: '?string',
  },
  execute(args, ctx) {
    return _setRoutine('weather_alert', { ...args, rain_threshold: args.rain_threshold || 60 }, ctx);
  },
};

const ROUTINE_DISABLE = {
  name: 'routine_disable',
  description: 'Desactiva una rutina configurada. type: "morning" | "bedtime" | "weather_alert".',
  params: { type: 'string' },
  execute(args, ctx) {
    if (!['morning', 'bedtime', 'weather_alert'].includes(args.type)) {
      return _err('type debe ser morning | bedtime | weather_alert');
    }
    return _setRoutine(args.type, { ...args, _removeOnly: true }, ctx);
  },
};

const ROUTINE_LIST = {
  name: 'routine_list',
  description: 'Lista las rutinas configuradas del usuario actual con su próximo trigger.',
  params: {},
  execute(_args, ctx) {
    if (!ctx.userPreferencesRepo || !ctx.scheduler?._actionsRepo) return _err('scheduler/prefs no disponibles');
    const userId = resolveUserId(ctx);
    if (!userId) return _err('No se pudo resolver userId');

    const types = ['morning', 'bedtime', 'weather_alert'];
    const out = {};
    for (const type of types) {
      const actionId = ctx.userPreferencesRepo.get(userId, _prefKey(type));
      if (!actionId) { out[type] = null; continue; }
      try {
        const a = ctx.scheduler._actionsRepo.getById(actionId);
        if (!a) { out[type] = null; continue; }
        out[type] = {
          id: a.id,
          cron_expr: a.cron_expr,
          timezone: a.timezone,
          next_run_at: a.next_run_at ? new Date(a.next_run_at).toISOString() : null,
          run_count: a.run_count,
          status: a.status,
        };
      } catch { out[type] = null; }
    }
    return _ok({ user_id: userId, routines: out });
  },
};

module.exports = [ROUTINE_MORNING_SET, ROUTINE_BEDTIME_SET, ROUTINE_WEATHER_ALERT, ROUTINE_DISABLE, ROUTINE_LIST];
