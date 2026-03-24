'use strict';

const bash          = require('./bash');
const files         = require('./files');          // array
const pty           = require('./pty');            // array
const telegram      = require('./telegram');       // array
const memory        = require('./memory');         // array
const critter       = require('./critter');        // array, channel: 'p2p'
const critterStatus = require('./critter-status');

const ALL_TOOLS = [bash, ...files, ...pty, ...telegram, ...memory, ...critter, critterStatus];

const _byName = new Map(ALL_TOOLS.map(t => [t.name, t]));

/** @returns {Array} todos los tools (filtrados por channel si se especifica) */
function all(opts = {}) {
  if (!opts.channel) return ALL_TOOLS.filter(t => !t.channel);
  return ALL_TOOLS.filter(t => !t.channel || t.channel === opts.channel);
}

/**
 * Ejecuta un tool por nombre.
 * @param {string}  name
 * @param {object}  args
 * @param {object}  [ctx]  - { shellId, sessionManager, memory }
 * @returns {Promise<string>}
 */
async function execute(name, args, ctx = {}) {
  const tool = _byName.get(name);
  if (!tool) return `Error: herramienta desconocida: ${name}`;
  try {
    return String(await tool.execute(args, ctx));
  } catch (err) {
    return `Error ejecutando ${name}: ${err.message}`;
  }
}

module.exports = { all, execute };
