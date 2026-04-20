'use strict';

/**
 * mcp/tools/catalog.js — tools MCP `tool_search` y `tool_load` (Fase 7 lazy loading).
 *
 * Dos tools **separadas** (no una con unión `{query|select}`), por decisión modular
 * del brief Fase 7.
 *
 * Ambas se apoyan en `ctx.toolCatalog` (instancia de `core/ToolCatalog`), inyectada
 * desde ConversationService al construir el ctx de MCP tools. El `sessionId` viene
 * de `ctx.chatId` — cada chat es una sesión de lazy loading independiente.
 */

const TOOL_SEARCH = {
  name: 'tool_search',
  description: 'Busca tools disponibles por substring en name o description. Retorna metadata (nombre + descripción). Usá tool_load después para traer el schema completo de las que querés invocar.',
  params: {
    query: 'string',
    limit: '?number',
  },
  execute(args = {}, ctx = {}) {
    if (!ctx.toolCatalog) return 'Error: toolCatalog no disponible en ctx';
    const query = String(args.query || '').trim();
    if (!query) return 'Error: query requerido';
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const hits = ctx.toolCatalog.search(query, limit);
    if (!hits.length) return '(sin resultados)';
    return hits.map(h => `- ${h.name}: ${h.description}`).join('\n');
  },
};

const TOOL_LOAD = {
  name: 'tool_load',
  description: 'Carga schemas completos de tools específicas para poder invocarlas en el turn actual. Params: names (array de strings). Retorna el schema de cada tool o "not_found".',
  params: {
    names: 'array',
  },
  execute(args = {}, ctx = {}) {
    if (!ctx.toolCatalog) return 'Error: toolCatalog no disponible en ctx';
    const names = Array.isArray(args.names) ? args.names : (args.names ? [String(args.names)] : []);
    if (!names.length) return 'Error: names requerido (array de strings)';
    const sessionId = ctx.chatId || 'default';
    const loaded = ctx.toolCatalog.load(names, sessionId);
    const parts = loaded.map(r => {
      if (r.error) return `- ${r.name}: ${r.error}`;
      return `- ${r.name}: ${r.description}\n  schema: ${JSON.stringify(r.inputSchema || {})}`;
    });
    return `Cargadas ${loaded.filter(r => !r.error).length}/${loaded.length} tools:\n${parts.join('\n')}`;
  },
};

module.exports = [TOOL_SEARCH, TOOL_LOAD];
