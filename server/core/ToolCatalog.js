'use strict';

/**
 * ToolCatalog — lazy loading de schemas de tools.
 *
 * Problema que resuelve: con 40+ tools registradas, el system prompt incluye el
 * schema completo de cada una (`inputSchema`), lo que puede consumir 5-15k tokens
 * per-turn sólo en tools. La mayoría no se usan en un turn dado.
 *
 * Solución: el system prompt incluye sólo **metadata** (name + description). El
 * modelo pide schemas completos via `tool_load({names:[...]})` o busca via
 * `tool_search({query})`. Una vez cargada en la sesión, la tool puede invocarse.
 *
 * Siempre visibles (exempt del lazy loading):
 *   - env `ALWAYS_VISIBLE_TOOLS=read_file,bash,tool_search,tool_load,task_create`
 *   - por agente: `agentDef.alwaysVisibleTools[]`
 *
 * Feature flag:
 *   - `LAZY_TOOLS_ENABLED=false` (default): todas las tools se incluyen full.
 *   - `LAZY_TOOLS_ENABLED=true`: comportamiento lazy activo.
 *   - `LAZY_TOOLS_ENABLED=auto`: reservado (auto-activar si toolsBlockTokens/contextWindow > 10%).
 */

const DEFAULT_ALWAYS_VISIBLE = ['read_file', 'bash', 'tool_search', 'tool_load', 'task_create'];

function _parseAlwaysVisible() {
  const env = process.env.ALWAYS_VISIBLE_TOOLS;
  if (!env) return DEFAULT_ALWAYS_VISIBLE.slice();
  return env.split(',').map(s => s.trim()).filter(Boolean);
}

function _parseMode() {
  const v = process.env.LAZY_TOOLS_ENABLED;
  if (v === 'true') return 'on';
  if (v === 'auto') return 'auto';
  return 'off';
}

class ToolCatalog {
  /**
   * @param {object} [opts]
   * @param {Array}  [opts.tools]          — array de tool defs (cada uno: {name, description, params|inputSchema, category?})
   * @param {string[]} [opts.alwaysVisible] — override por constructor (default lee env)
   * @param {string} [opts.mode]            — 'on'|'off'|'auto' (default lee env)
   */
  constructor({ tools = [], alwaysVisible, mode } = {}) {
    /** @type {Map<string, { metadata: object, schema: object|undefined }>} */
    this._tools = new Map();
    for (const t of tools) this.register(t);
    this._alwaysVisible = new Set(Array.isArray(alwaysVisible) ? alwaysVisible : _parseAlwaysVisible());
    this._mode = mode || _parseMode();
    /** @type {Map<string, Set<string>>} sessionId → loadedToolNames */
    this._sessionCache = new Map();
  }

  get mode() { return this._mode; }
  setMode(m) { this._mode = m; }

  /** Registra (o sobrescribe) una tool. */
  register(tool) {
    if (!tool || !tool.name) return;
    const schema = tool.inputSchema || (tool.params ? { __params: tool.params } : undefined);
    this._tools.set(tool.name, {
      metadata: {
        name:        tool.name,
        description: tool.description || '',
        category:    tool.category || null,
      },
      schema,
    });
  }

  /** Retorna la metadata (y schema si aplica) para incluir en el system prompt. */
  getPromptTools(agentDef = null, sessionId = null) {
    const agentVisible = Array.isArray(agentDef?.alwaysVisibleTools) ? agentDef.alwaysVisibleTools : [];
    const visible = new Set([...this._alwaysVisible, ...agentVisible]);
    const loaded = sessionId ? (this._sessionCache.get(sessionId) || new Set()) : new Set();

    return Array.from(this._tools.values()).map(({ metadata, schema }) => {
      const isVisible = visible.has(metadata.name) || loaded.has(metadata.name);
      const lazyMode = this._mode !== 'off';
      if (!lazyMode || isVisible) {
        // Incluir schema completo
        return { ...metadata, inputSchema: schema };
      }
      // Solo metadata
      return { ...metadata };
    });
  }

  /** True si la tool se puede invocar (loaded o siempre visible) para esa sesión. */
  isLoaded(toolName, sessionId = null) {
    if (this._mode === 'off') return true; // lazy disabled → todas visibles siempre
    if (this._alwaysVisible.has(toolName)) return true;
    if (!sessionId) return false;
    const set = this._sessionCache.get(sessionId);
    return !!(set && set.has(toolName));
  }

  /**
   * Búsqueda fuzzy por substring. Usado por la tool `tool_search`.
   * @returns {Array<{name, description}>}
   */
  search(query, limit = 10) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const hits = [];
    for (const { metadata } of this._tools.values()) {
      if (metadata.name.toLowerCase().includes(q) || metadata.description.toLowerCase().includes(q)) {
        hits.push({ name: metadata.name, description: metadata.description });
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  /**
   * Carga schemas completos y los marca como disponibles para la sesión.
   * Usado por la tool `tool_load`.
   * @returns {Array<{name, description, inputSchema?, error?}>}
   */
  load(names, sessionId) {
    const loaded = this._sessionCache.get(sessionId) || new Set();
    const result = [];
    for (const name of (Array.isArray(names) ? names : [names])) {
      const t = this._tools.get(name);
      if (!t) {
        result.push({ name, error: 'not_found' });
        continue;
      }
      loaded.add(name);
      result.push({ name, description: t.metadata.description, inputSchema: t.schema });
    }
    this._sessionCache.set(sessionId, loaded);
    return result;
  }

  /** Limpia la cache de sesión (ej. al inicio de un nuevo chat). */
  resetSession(sessionId) {
    if (sessionId) this._sessionCache.delete(sessionId);
    else this._sessionCache.clear();
  }

  /** @returns {string[]} nombres de tools registradas */
  listNames() {
    return Array.from(this._tools.keys());
  }

  /** Cuántas tools están registradas */
  size() { return this._tools.size; }
}

ToolCatalog.DEFAULT_ALWAYS_VISIBLE = DEFAULT_ALWAYS_VISIBLE;
module.exports = ToolCatalog;
