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

const ALL_TOOLS = [bash, git, ...files, ...pty, ...telegram, ...memory, ...webchat, ...critter, critterStatus, ...users, ...scheduled, ...contacts, ...orchestration];

const _byName = new Map(ALL_TOOLS.map(t => [t.name, t]));

// Lazy-load del pool de MCPs externos
let _pool = null;
function _getPool() {
  if (!_pool) try { _pool = require('../../mcp-client-pool'); } catch {}
  return _pool;
}

/** @returns {Array} todos los tools (internos + externos, filtrados por channel y agentRole) */
function all(opts = {}) {
  const pool = _getPool();
  const external = pool ? pool.getExternalToolDefs() : [];
  let result = [...ALL_TOOLS, ...external];
  // Filtrar por channel
  result = opts.channel
    ? result.filter(t => !t.channel || t.channel === opts.channel)
    : result.filter(t => !t.channel);
  // Filtrar tools de coordinación (solo para role='coordinator')
  if (opts.agentRole !== 'coordinator') {
    result = result.filter(t => !t.coordinatorOnly);
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
  // Tools internos (prioridad)
  const tool = _byName.get(name);
  if (tool) {
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
