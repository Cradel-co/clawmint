'use strict';

/**
 * mcp/tools/tasks.js — Tools MCP para gestión de tareas persistentes.
 *
 * Scoped por `chat_id` del ctx. Admins (chat_id='*') ven todo.
 * Jerarquía con `parent_id` + cascade delete.
 * Estados válidos: pending, in_progress, completed, cancelled, blocked.
 */

const { isAdmin, resolveUserId } = require('./user-sandbox');

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled', 'blocked'];

function _repo(ctx) {
  if (!ctx.tasksRepo) throw new Error('tasksRepo no disponible en ctx');
  return ctx.tasksRepo;
}

function _scope(ctx) {
  return isAdmin(ctx) && ctx._adminGlobal === true ? '*' : String(ctx.chatId || '');
}

// A1 — Emite un hook observacional sin bloquear la tool.
function _emitHook(ctx, event, payload) {
  const hr = ctx && ctx.hookRegistry;
  if (!hr || !hr.enabled) return;
  const hookCtx = { chatId: ctx.chatId, userId: ctx.userId, agentKey: ctx.agentKey, channel: ctx.channel };
  Promise.resolve()
    .then(() => hr.emit(event, payload, hookCtx))
    .catch(() => {}); // fire-and-forget: no contaminar el retorno de la tool
}

function _fmtRow(t) {
  return `#${t.id} [${t.status}] ${t.title}`;
}

const TASK_CREATE = {
  name: 'task_create',
  description: 'Crea una tarea persistente para este chat. Podés anidar con parent_id y adjuntar metadata (priority, tags, due_ts).',
  params: {
    title: 'string',
    description: '?string',
    parent_id: '?number',
    metadata: '?object',
  },
  execute(args = {}, ctx = {}) {
    const repo = _repo(ctx);
    if (!args.title) return 'Error: title requerido';
    const row = repo.create({
      chat_id:   String(ctx.chatId || ''),
      user_id:   resolveUserId(ctx) || null,
      agent_key: ctx.agentKey || null,
      title:     String(args.title),
      description: args.description ? String(args.description) : null,
      parent_id: args.parent_id ? Number(args.parent_id) : null,
      metadata:  args.metadata && typeof args.metadata === 'object' ? args.metadata : null,
    });
    if (!row) return 'Error: no se pudo crear la tarea';
    _emitHook(ctx, 'task_created', {
      id: row.id, title: row.title, parent_id: row.parent_id || null,
      chat_id: row.chat_id, user_id: row.user_id, agent_key: row.agent_key,
    });
    return `Creada #${row.id}: ${row.title}`;
  },
};

const TASK_LIST = {
  name: 'task_list',
  description: 'Lista tareas del chat actual. Filtrable por status y parent_id.',
  params: {
    status: '?string',
    parent_id: '?number',
    limit: '?number',
  },
  execute(args = {}, ctx = {}) {
    const repo = _repo(ctx);
    if (args.status && !VALID_STATUSES.includes(args.status)) {
      return `Error: status debe ser uno de: ${VALID_STATUSES.join(', ')}`;
    }
    const rows = repo.list({
      chat_id:   _scope(ctx),
      status:    args.status,
      parent_id: args.parent_id !== undefined ? (args.parent_id === null ? null : Number(args.parent_id)) : undefined,
      limit:     args.limit ? Number(args.limit) : 20,
    });
    if (!rows.length) return 'Sin tareas.';
    return rows.map(_fmtRow).join('\n');
  },
};

const TASK_GET = {
  name: 'task_get',
  description: 'Obtiene los detalles completos de una tarea por id (incluye subtareas).',
  params: { id: 'number' },
  execute(args = {}, ctx = {}) {
    const repo = _repo(ctx);
    if (!args.id) return 'Error: id requerido';
    const scope = _scope(ctx);
    const task = repo.getById(args.id, scope);
    if (!task) return `Error: tarea #${args.id} no existe o no te pertenece`;
    const children = repo.children(task.id, scope);
    return JSON.stringify({ ...task, children }, null, 2);
  },
};

const TASK_UPDATE = {
  name: 'task_update',
  description: 'Actualiza campos de una tarea (title, description, status, metadata). Status válidos: pending, in_progress, completed, cancelled, blocked.',
  params: {
    id: 'number',
    title: '?string',
    description: '?string',
    status: '?string',
    metadata: '?object',
  },
  execute(args = {}, ctx = {}) {
    const repo = _repo(ctx);
    if (!args.id) return 'Error: id requerido';
    if (args.status && !VALID_STATUSES.includes(args.status)) {
      return `Error: status debe ser uno de: ${VALID_STATUSES.join(', ')}`;
    }
    const scope = _scope(ctx);
    const existing = repo.getById(args.id, scope);
    if (!existing) return `Error: tarea #${args.id} no existe o no te pertenece`;
    const ok = repo.update(args.id, scope, {
      title: args.title,
      description: args.description,
      status: args.status,
      metadata: args.metadata,
    });
    // A1 — task_completed dispara solo en transición pending|in_progress → completed
    if (ok && args.status === 'completed' && existing.status !== 'completed') {
      _emitHook(ctx, 'task_completed', {
        id: existing.id, title: existing.title, previous_status: existing.status,
        chat_id: existing.chat_id, user_id: existing.user_id, agent_key: existing.agent_key,
      });
    }
    return ok ? `Actualizada #${args.id}` : `Sin cambios en #${args.id}`;
  },
};

const TASK_DELETE = {
  name: 'task_delete',
  description: 'Elimina una tarea y sus subtareas (cascade).',
  params: { id: 'number' },
  execute(args = {}, ctx = {}) {
    const repo = _repo(ctx);
    if (!args.id) return 'Error: id requerido';
    const scope = _scope(ctx);
    const existing = repo.getById(args.id, scope);
    if (!existing) return `Error: tarea #${args.id} no existe o no te pertenece`;
    const { removed, descendants } = repo.remove(args.id, scope);
    if (!removed) return `Error: no se eliminó #${args.id}`;
    return descendants > 0
      ? `Eliminada #${args.id} (y ${descendants} subtareas)`
      : `Eliminada #${args.id}`;
  },
};

module.exports = [TASK_CREATE, TASK_LIST, TASK_GET, TASK_UPDATE, TASK_DELETE];
