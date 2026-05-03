'use strict';

/**
 * mcp/tools/typedMemory.js — tools MCP para memoria tipada (Fase 8).
 *
 * - memory_save_typed: persiste una memoria con tipo + scope.
 * - memory_list_typed: lista memorias por filtros.
 * - memory_forget: elimina una memoria por name.
 *
 * Resolución de scope:
 *   - `scope_type` explícito (si lo pasa el modelo).
 *   - Sino, default: 'chat' con scope_id=ctx.chatId.
 *
 * Namespace de aislamiento por usuario — Fase 8.3:
 *   - Para `scope=user`, `scope_id` se resuelve automáticamente desde ctx.userId.
 *   - Si no hay userId en ctx, la operación falla con mensaje claro.
 */

const { resolveUserId } = require('./user-sandbox');

const VALID_KINDS = ['user', 'feedback', 'project', 'reference', 'freeform'];
const VALID_SCOPES = ['user', 'chat', 'agent', 'global'];

function _resolveScope(args, ctx) {
  const type = args.scope_type || 'chat';
  if (!VALID_SCOPES.includes(type)) return { error: `scope_type inválido: ${type} (válidos: ${VALID_SCOPES.join(', ')})` };
  let id = args.scope_id || null;
  // Auto-resolve IDs según tipo
  if (type === 'user') {
    id = resolveUserId(ctx) || id;
    if (!id) return { error: 'no se pudo resolver userId para scope=user' };
  } else if (type === 'chat') {
    id = id || String(ctx.chatId || '');
    if (!id) return { error: 'chatId no disponible en ctx' };
  } else if (type === 'agent') {
    id = id || String(ctx.agentKey || '');
    if (!id) return { error: 'agentKey no disponible en ctx' };
  } else if (type === 'global') {
    id = null; // global no tiene scope_id
  }
  return { type, id };
}

const SAVE = {
  name: 'memory_save_typed',
  description: 'Guarda una memoria tipada. kind ∈ {user|feedback|project|reference|freeform}. scope ∈ {user|chat|agent|global}. Sobrescribe si ya existe una con el mismo name en el scope.',
  params: {
    kind: 'string',
    name: 'string',
    body: 'string',
    description: '?string',
    scope_type: '?string',
    scope_id: '?string',
  },
  execute(args = {}, ctx = {}) {
    if (!ctx.typedMemoryService) return 'Error: typedMemoryService no disponible';
    if (!VALID_KINDS.includes(args.kind)) return `Error: kind inválido (válidos: ${VALID_KINDS.join(', ')})`;
    if (!args.name) return 'Error: name requerido';
    if (!args.body) return 'Error: body requerido';

    const scope = _resolveScope(args, ctx);
    if (scope.error) return `Error: ${scope.error}`;

    try {
      const row = ctx.typedMemoryService.save({
        scope_type:  scope.type,
        scope_id:    scope.id,
        kind:        args.kind,
        name:        args.name,
        description: args.description || null,
        body:        String(args.body),
      });
      return `Guardada memoria "${row.name}" (kind=${row.kind}, scope=${row.scope_type}${row.scope_id ? ':' + row.scope_id : ''})`;
    } catch (err) {
      return `Error guardando memoria: ${err.message}`;
    }
  },
};

const LIST = {
  name: 'memory_list_typed',
  description: 'Lista memorias tipadas del scope indicado. Devuelve metadata (name + kind + description), no bodies.',
  params: {
    kind: '?string',
    scope_type: '?string',
    scope_id: '?string',
  },
  execute(args = {}, ctx = {}) {
    if (!ctx.typedMemoryService) return 'Error: typedMemoryService no disponible';
    if (args.kind && !VALID_KINDS.includes(args.kind)) return `Error: kind inválido (válidos: ${VALID_KINDS.join(', ')})`;

    // Si scope_type se especifica, resolver id. Si no, listar todo.
    let filter = { kind: args.kind };
    if (args.scope_type) {
      const scope = _resolveScope(args, ctx);
      if (scope.error) return `Error: ${scope.error}`;
      filter.scope_type = scope.type;
      filter.scope_id   = scope.id;
    }
    const rows = ctx.typedMemoryService.list(filter);
    if (!rows.length) return '(sin memorias)';
    return rows.map(r => {
      const desc = r.description ? ` — ${r.description}` : '';
      const scope = r.scope_type + (r.scope_id ? ':' + r.scope_id : '');
      return `- [${r.kind}] ${r.name} (${scope})${desc}`;
    }).join('\n');
  },
};

const FORGET = {
  name: 'memory_forget',
  description: 'Elimina una memoria tipada por name + scope.',
  params: {
    name: 'string',
    scope_type: '?string',
    scope_id: '?string',
  },
  execute(args = {}, ctx = {}) {
    if (!ctx.typedMemoryService) return 'Error: typedMemoryService no disponible';
    if (!args.name) return 'Error: name requerido';

    const scope = _resolveScope(args, ctx);
    if (scope.error) return `Error: ${scope.error}`;

    const ok = ctx.typedMemoryService.forget({ scope_type: scope.type, scope_id: scope.id, name: args.name });
    if (!ok) return `No se encontró memoria "${args.name}" en scope ${scope.type}${scope.id ? ':' + scope.id : ''}`;
    return `Eliminada memoria "${args.name}"`;
  },
};

module.exports = [SAVE, LIST, FORGET];
