'use strict';

/**
 * mcp/tools/household.js — datos compartidos del hogar (Fase B).
 *
 * Tools agrupadas por dominio (kind):
 *   - grocery_*    → lista de mercadería pendiente
 *   - family_event_* → cumpleaños, vencimientos, citas (con fecha + alerta)
 *   - house_note_* → recados estables del hogar
 *   - service_*    → servicios con vencimiento (gas, luz, internet)
 *   - inventory_*  → heladera/despensa con cantidad
 *
 * Permisos: cualquier user `status='active'` puede leer/escribir. Validamos
 * en cada tool con resolveUserId(ctx) — si no hay user (canal anónimo), se
 * permite con 'system' como creator (telegram bot sin auth aún).
 */

const { resolveUserId } = require('./user-sandbox');

function _getRepo(ctx) {
  if (!ctx.householdRepo) throw new Error('householdRepo no disponible en ctx');
  return ctx.householdRepo;
}

function _userOrSystem(ctx) {
  return resolveUserId(ctx) || 'system';
}

function _err(msg) { return JSON.stringify({ error: msg }); }
function _ok(payload) { return JSON.stringify(payload, null, 2); }

// ── Mercadería (grocery) ────────────────────────────────────────────────────

const GROCERY_ADD = {
  name: 'grocery_add',
  description: 'Agrega un item a la lista de mercadería compartida del hogar. Cualquier miembro lo ve.',
  params: {
    item: 'string',           // ej. "leche"
    quantity: '?string',      // ej. "2 litros", "3"
    category: '?string',      // ej. "lácteos", "limpieza"
  },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    if (!args.item) return _err('Pasá `item`.');
    const created = repo.create({
      kind: 'grocery_item',
      title: args.item,
      data: { quantity: args.quantity || null, category: args.category || null },
      createdBy: _userOrSystem(ctx),
    });
    return _ok({ ok: true, item: created });
  },
};

const GROCERY_LIST = {
  name: 'grocery_list',
  description: 'Lista mercadería pendiente del hogar (no comprada todavía). includeCompleted=true incluye comprados recientes.',
  params: { includeCompleted: '?boolean', limit: '?number' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    const items = repo.list('grocery_item', { includeCompleted: !!args.includeCompleted, limit: args.limit || null });
    return _ok({ count: items.length, items });
  },
};

const GROCERY_CHECK = {
  name: 'grocery_check',
  description: 'Marca un item de mercadería como comprado. Pasá id (de grocery_list) o item (busca por nombre).',
  params: { id: '?string', item: '?string' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    let id = args.id;
    if (!id && args.item) {
      const items = repo.list('grocery_item');
      const match = items.find(i => i.title.toLowerCase().includes(args.item.toLowerCase()));
      if (!match) return _err(`No encontré "${args.item}" en la lista.`);
      id = match.id;
    }
    if (!id) return _err('Pasá `id` o `item`.');
    const ok = repo.complete(id, _userOrSystem(ctx));
    return _ok({ ok, id });
  },
};

const GROCERY_CLEAR = {
  name: 'grocery_clear',
  description: 'Elimina items de mercadería ya comprados (limpia la lista). Conserva pendientes.',
  params: {},
  execute(_args, ctx) {
    const repo = _getRepo(ctx);
    const completed = repo.list('grocery_item', { includeCompleted: true }).filter(i => i.completed_at);
    let removed = 0;
    for (const i of completed) { if (repo.remove(i.id)) removed++; }
    return _ok({ ok: true, removed });
  },
};

// ── Eventos familiares (family_event) ───────────────────────────────────────

const FAMILY_EVENT_ADD = {
  name: 'family_event_add',
  description: 'Agrega un evento familiar (cumpleaños, vencimiento, cita médica, reunión). Pasá fecha en formato YYYY-MM-DD. alertDaysBefore para reminders automáticos N días antes (default 3).',
  params: {
    title: 'string',         // "Cumple de Tomás"
    date: 'string',          // "2026-06-15"
    alertDaysBefore: '?number', // default 3
    type: '?string',         // "birthday" | "expiration" | "appointment" | "meeting" | "other"
    notes: '?string',
    recurrence: '?string',   // "yearly" | "monthly" | "none". Default "yearly" para birthday.
  },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    if (!args.title || !args.date) return _err('Pasá `title` y `date` (YYYY-MM-DD).');
    const dateAt = new Date(args.date + 'T09:00:00').getTime();
    if (isNaN(dateAt)) return _err('Formato de fecha inválido. Usá YYYY-MM-DD.');
    const type = args.type || 'other';
    const recurrence = args.recurrence || (type === 'birthday' ? 'yearly' : 'none');
    const created = repo.create({
      kind: 'family_event',
      title: args.title,
      data: { type, recurrence, notes: args.notes || null },
      dateAt,
      alertDaysBefore: args.alertDaysBefore != null ? Number(args.alertDaysBefore) : 3,
      createdBy: _userOrSystem(ctx),
    });
    return _ok({ ok: true, event: created });
  },
};

const FAMILY_EVENT_LIST = {
  name: 'family_event_list',
  description: 'Lista todos los eventos familiares. upcomingOnly=true (default) muestra solo próximos.',
  params: { upcomingOnly: '?boolean', limit: '?number' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    const upcomingOnly = args.upcomingOnly !== false;
    const items = repo.list('family_event', { includeCompleted: true, upcomingOnly, limit: args.limit || null });
    return _ok({ count: items.length, events: items });
  },
};

const FAMILY_EVENT_UPCOMING = {
  name: 'family_event_upcoming',
  description: 'Eventos familiares en los próximos N días (default 7). Para morning_brief o agenda semanal.',
  params: { days: '?number' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    const items = repo.upcomingAlerts(args.days || 7).filter(i => i.kind === 'family_event');
    return _ok({ count: items.length, days: args.days || 7, events: items });
  },
};

const FAMILY_EVENT_REMOVE = {
  name: 'family_event_remove',
  description: 'Elimina un evento familiar por id.',
  params: { id: 'string' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    if (!args.id) return _err('Pasá `id`.');
    return _ok({ ok: repo.remove(args.id), id: args.id });
  },
};

// ── Notas del hogar (house_note) ────────────────────────────────────────────

const HOUSE_NOTE_ADD = {
  name: 'house_note_add',
  description: 'Guarda una nota del hogar (recado, info estable: wifi, dirección, teléfono del plomero, etc.). Visible para todos.',
  params: { title: 'string', content: 'string', tags: '?string' /* CSV */ },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    if (!args.title || !args.content) return _err('Pasá `title` y `content`.');
    const tags = args.tags ? args.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const created = repo.create({
      kind: 'house_note',
      title: args.title,
      data: { content: args.content, tags },
      createdBy: _userOrSystem(ctx),
    });
    return _ok({ ok: true, note: created });
  },
};

const HOUSE_NOTE_LIST = {
  name: 'house_note_list',
  description: 'Lista notas del hogar. tag opcional para filtrar.',
  params: { tag: '?string', limit: '?number' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    let items = repo.list('house_note', { includeCompleted: true, limit: args.limit || null });
    if (args.tag) items = items.filter(n => Array.isArray(n.data?.tags) && n.data.tags.includes(args.tag));
    return _ok({ count: items.length, notes: items });
  },
};

const HOUSE_NOTE_REMOVE = {
  name: 'house_note_remove',
  description: 'Elimina una nota del hogar por id.',
  params: { id: 'string' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    return _ok({ ok: repo.remove(args.id), id: args.id });
  },
};

// ── Servicios (service) ─────────────────────────────────────────────────────

const SERVICE_ADD = {
  name: 'service_add',
  description: 'Registra un servicio del hogar con vencimiento (gas, luz, internet, expensas, ABL). Genera alerta N días antes.',
  params: {
    name: 'string',          // "Edenor luz"
    dueDate: 'string',       // "2026-05-10"
    amount: '?number',       // monto opcional
    currency: '?string',     // "ARS" default
    alertDaysBefore: '?number', // default 5
    notes: '?string',
  },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    if (!args.name || !args.dueDate) return _err('Pasá `name` y `dueDate`.');
    const dateAt = new Date(args.dueDate + 'T12:00:00').getTime();
    if (isNaN(dateAt)) return _err('Fecha inválida.');
    const created = repo.create({
      kind: 'service',
      title: args.name,
      data: { amount: args.amount || null, currency: args.currency || 'ARS', notes: args.notes || null },
      dateAt,
      alertDaysBefore: args.alertDaysBefore != null ? Number(args.alertDaysBefore) : 5,
      createdBy: _userOrSystem(ctx),
    });
    return _ok({ ok: true, service: created });
  },
};

const SERVICE_LIST = {
  name: 'service_list',
  description: 'Lista servicios del hogar. upcomingOnly=true (default) muestra solo no vencidos. includePaid=true incluye marcados pagados.',
  params: { upcomingOnly: '?boolean', includePaid: '?boolean' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    const items = repo.list('service', {
      includeCompleted: args.includePaid === true,
      upcomingOnly: args.upcomingOnly !== false,
    });
    return _ok({ count: items.length, services: items });
  },
};

const SERVICE_PAID = {
  name: 'service_paid',
  description: 'Marca un servicio como pagado. Pasá id o name (busca match parcial).',
  params: { id: '?string', name: '?string' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    let id = args.id;
    if (!id && args.name) {
      const items = repo.list('service', { includeCompleted: true });
      const match = items.find(i => i.title.toLowerCase().includes(args.name.toLowerCase()));
      if (!match) return _err(`No encontré servicio "${args.name}".`);
      id = match.id;
    }
    if (!id) return _err('Pasá `id` o `name`.');
    return _ok({ ok: repo.complete(id, _userOrSystem(ctx)), id });
  },
};

// ── Inventario (inventory) — heladera/despensa ─────────────────────────────

const INVENTORY_ADD = {
  name: 'inventory_add',
  description: 'Agrega un item al inventario (heladera/despensa) con cantidad. "¿hay leche?" → consultar inventory_list.',
  params: { item: 'string', quantity: '?string', location: '?string' /* "heladera" | "despensa" */ },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    if (!args.item) return _err('Pasá `item`.');
    const created = repo.create({
      kind: 'inventory',
      title: args.item,
      data: { quantity: args.quantity || '1', location: args.location || 'despensa' },
      createdBy: _userOrSystem(ctx),
    });
    return _ok({ ok: true, item: created });
  },
};

const INVENTORY_LIST = {
  name: 'inventory_list',
  description: 'Lista items del inventario (heladera/despensa). Filtros opcionales por location.',
  params: { location: '?string' /* "heladera" | "despensa" */ },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    let items = repo.list('inventory', { includeCompleted: false });
    if (args.location) items = items.filter(i => i.data?.location === args.location);
    return _ok({ count: items.length, items });
  },
};

const INVENTORY_CONSUME = {
  name: 'inventory_consume',
  description: 'Marca un item del inventario como consumido (sale del listado). Pasá id o item (busca por nombre).',
  params: { id: '?string', item: '?string' },
  execute(args, ctx) {
    const repo = _getRepo(ctx);
    let id = args.id;
    if (!id && args.item) {
      const items = repo.list('inventory');
      const match = items.find(i => i.title.toLowerCase().includes(args.item.toLowerCase()));
      if (!match) return _err(`No encontré "${args.item}" en el inventario.`);
      id = match.id;
    }
    if (!id) return _err('Pasá `id` o `item`.');
    return _ok({ ok: repo.complete(id, _userOrSystem(ctx)), id });
  },
};

// ── Resumen general ────────────────────────────────────────────────────────

const HOUSEHOLD_SUMMARY = {
  name: 'household_summary',
  description: 'Resumen del estado del hogar: counts por categoría + próximos eventos + servicios por vencer + items pendientes. Útil para morning_brief.',
  params: {},
  execute(_args, ctx) {
    const repo = _getRepo(ctx);
    return _ok({
      counts:    repo.counts(),
      upcoming:  repo.upcomingAlerts(7),
      grocery_pending:  repo.list('grocery_item', { limit: 5 }).length,
      services_due:     repo.list('service',      { upcomingOnly: true, limit: 5 }).length,
      events_this_week: repo.upcomingAlerts(7).filter(i => i.kind === 'family_event').length,
    });
  },
};

module.exports = [
  GROCERY_ADD, GROCERY_LIST, GROCERY_CHECK, GROCERY_CLEAR,
  FAMILY_EVENT_ADD, FAMILY_EVENT_LIST, FAMILY_EVENT_UPCOMING, FAMILY_EVENT_REMOVE,
  HOUSE_NOTE_ADD, HOUSE_NOTE_LIST, HOUSE_NOTE_REMOVE,
  SERVICE_ADD, SERVICE_LIST, SERVICE_PAID,
  INVENTORY_ADD, INVENTORY_LIST, INVENTORY_CONSUME,
  HOUSEHOLD_SUMMARY,
];
