'use strict';

const bash          = require('./bash');
const files         = require('./files');          // array
const pty           = require('./pty');            // array
const telegram      = require('./telegram');       // array
const memory        = require('./memory');         // array
const webchat       = require('./webchat');        // array
const git           = require('./git');
const critter       = require('./critter');        // array, channel: 'p2p'
const critterStatus = require('./critter-status');
const users         = require('./users');          // array
const scheduled     = require('./scheduled');      // array
const contacts      = require('./contacts');       // array
const orchestration = require('./orchestration');  // array, coordinatorOnly
const search        = require('./search');         // array [glob, grep]
const web           = require('./web');            // array [webfetch, websearch]
const tasks         = require('./tasks');          // array [task_create, task_list, task_get, task_update, task_delete]
const skills        = require('./skills');         // array [skill_list, skill_invoke]
const catalog       = require('./catalog');        // array [tool_search, tool_load] — Fase 7 lazy loading
const typedMemory   = require('./typedMemory');    // array [memory_save_typed, memory_list_typed, memory_forget] — Fase 8
// Fase 9 — tools agénticas
const notebook      = require('./notebook');       // array [notebook_edit]
const planMode      = require('./planMode');       // array [enter_plan_mode, exit_plan_mode]
const monitor       = require('./monitor');        // array [monitor_process]
const cronTools     = require('./cron');           // array [cron_create, cron_list, cron_delete]
const notify        = require('./notify');         // array [push_notification]
const agenticParked = require('./agenticParked');  // array [schedule_wakeup, ask_user_question] — stubs
const mcpAuth       = require('./mcpAuth');        // array [mcp_authenticate, mcp_complete_authentication, mcp_list_authenticated] — Fase 11.1
const lsp           = require('./lsp');            // array [lsp_go_to_definition, lsp_find_references, lsp_hover, lsp_document_symbols, lsp_workspace_symbols, lsp_diagnostics] — Fase 10
const workspace     = require('./workspace');      // array [workspace_status] — Fase 8.4 parked → cerrado (admin-only)
const location      = require('./location');       // array [server_info, server_location, weather_get] — info del server + clima
const userLocation  = require('./userLocation');   // array [user_location_save, user_location_get, user_location_forget] — preferencia geo del user
const environment   = require('./environment');    // array [air_quality_get, sun_get, moon_phase, uv_index_get, holiday_check, is_weekend]
const arFinance     = require('./arFinance');      // array [dolar_ar, feriados_ar, currency_convert, crypto_price, wikipedia_summary, recipe_random, recipe_search, joke_get]
const briefs        = require('./briefs');         // array [day_summary, morning_brief, bedtime_brief, week_ahead]
const household     = require('./household');      // array [grocery_*, family_event_*, house_note_*, service_*, inventory_*, household_summary] — Fase B
const routines      = require('./routines');       // array [routine_morning_set, routine_bedtime_set, routine_weather_alert, routine_disable, routine_list] — Fase C
const openaiCompat  = require('./openaiCompat');   // array [openai_compat_status, openai_compat_set_key, openai_compat_set_model]
const { isAdmin }   = require('./user-sandbox');

const ALL_TOOLS = [
  bash, git,
  ...files, ...pty, ...telegram, ...memory, ...webchat, ...critter, critterStatus,
  ...users, ...scheduled, ...contacts, ...orchestration,
  ...search, ...web, ...tasks, ...skills, ...catalog, ...typedMemory,
  ...notebook, ...planMode, ...monitor, ...cronTools, ...notify, ...agenticParked,
  ...mcpAuth, ...lsp, ...workspace, ...location, ...userLocation,
  ...environment, ...arFinance, ...briefs, ...household, ...routines,
  ...openaiCompat,
];

/** Set de tools desactivadas vía env var `MCP_DISABLED_TOOLS` (CSV). Permite rollback sin rebuild. */
const _disabledTools = new Set(
  (process.env.MCP_DISABLED_TOOLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

const _byName = new Map(ALL_TOOLS.map(t => [t.name, t]));

// Herramientas restringidas solo a administradores (acceso al sistema)
const ADMIN_ONLY_TOOLS = new Set([
  'bash', 'git', 'pty_create', 'pty_exec', 'pty_write', 'pty_read',
]);

// Lazy-load del pool de MCPs externos
let _pool = null;
function _getPool() {
  if (!_pool) try { _pool = require('../../mcp-client-pool'); } catch {}
  return _pool;
}

/** Glob matching simple: '*' matches all; 'prefix_*' matches prefixes; exact match otherwise. */
function _matchesPattern(name, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('_*')) {
    const prefix = pattern.slice(0, -2);
    return name === prefix || name.startsWith(prefix + '_');
  }
  return name === pattern;
}

/**
 * @param {object} opts
 * @param {string} [opts.channel]
 * @param {string} [opts.agentRole]
 * @param {boolean} [opts.isDelegated]             — si true, oculta tools coordinatorOnly aunque el role sea coordinator
 * @param {string[]|null} [opts.allowedToolPatterns] — filtro por subagente tipado; null = sin restricción
 * @returns {Array} todos los tools (internos + externos, filtrados)
 */
function all(opts = {}) {
  const pool = _getPool();
  const external = pool ? pool.getExternalToolDefs() : [];
  let result = [...ALL_TOOLS, ...external];
  // Filtrar por channel
  result = opts.channel
    ? result.filter(t => !t.channel || t.channel === opts.channel)
    : result.filter(t => !t.channel);
  // Filtrar tools de coordinación (solo para role='coordinator' Y NO delegado)
  // Bug fix Fase 5: un delegado con role=coordinator no debe recibir delegate_task (re-delegación).
  if (opts.agentRole !== 'coordinator' || opts.isDelegated === true) {
    result = result.filter(t => !t.coordinatorOnly);
  }
  // Filtrar tools deshabilitadas via MCP_DISABLED_TOOLS
  if (_disabledTools.size) {
    result = result.filter(t => !_disabledTools.has(t.name));
  }
  // Filtrar por subagente tipado (allowedToolPatterns)
  if (Array.isArray(opts.allowedToolPatterns)) {
    const patterns = opts.allowedToolPatterns;
    // Si incluye '*', no filtrar
    if (!patterns.includes('*')) {
      result = result.filter(t => patterns.some(p => _matchesPattern(t.name, p)));
    }
  }
  return result;
}

/**
 * Ejecuta un tool por nombre.
 * Primero busca en tools internos, luego en MCPs externos.
 * @param {string}  name
 * @param {object}  args
 * @param {object}  [ctx]  - { shellId, sessionManager, memory }
 * @returns {Promise<string>}
 */
async function execute(name, args, ctx = {}) {
  // Gate: tool deshabilitada por MCP_DISABLED_TOOLS
  if (_disabledTools.has(name)) {
    return `Error: la herramienta "${name}" está deshabilitada (MCP_DISABLED_TOOLS).`;
  }
  // Tools internos (prioridad)
  const tool = _byName.get(name);
  if (tool) {
    // Gate Fase 5: un agente delegado NO puede invocar tools coordinatorOnly.
    // Evita re-delegación aunque un delegado con role=coordinator fuerce el agentRole en su ctx.
    if (tool.coordinatorOnly && ctx._isDelegated === true) {
      return `Error: la herramienta "${name}" no está disponible para agentes delegados.`;
    }
    // Gate Fase 5: un subagente tipado tiene toolset restringido por allowedToolPatterns.
    if (Array.isArray(ctx.allowedToolPatterns) && ctx.allowedToolPatterns.length > 0) {
      const patterns = ctx.allowedToolPatterns;
      const allowed = patterns.includes('*') || patterns.some(p => _matchesPattern(name, p));
      if (!allowed) {
        return `Error: la herramienta "${name}" no está permitida para este subagente (allowed: ${patterns.join(', ')}).`;
      }
    }
    // Gate: herramientas de sistema solo para admins
    if (ADMIN_ONLY_TOOLS.has(name) && !isAdmin(ctx)) {
      return `Error: la herramienta "${name}" solo está disponible para administradores.`;
    }
    try {
      return String(await tool.execute(args, ctx));
    } catch (err) {
      return `Error ejecutando ${name}: ${err.message}`;
    }
  }
  // Tools externos (MCPs)
  const pool = _getPool();
  if (pool && pool.isExternalTool(name)) {
    return pool.callTool(name, args);
  }
  return `Error: herramienta desconocida: ${name}`;
}

module.exports = { all, execute };
